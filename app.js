/**
 * DronePlanner Premium Core Business Logic
 * Turf.js 기반 그리드 경로 생성 및 Open-Meteo DEM 지형 데이터 추출, DJI Waypoints V3 KMZ 빌더
 */

let MAPBOX_KEY = "";
let map, drawnItems, currentPolygon;
let waypoints = [];

// 드론 기종별 카메라 화각 설정 (35mm 환산 환산 크기 기준)
const DRONE_PRESETS = {
  mini4pro: { hfov: 73.7, vfov: 53.1 },
  mavic3pro: { hfov: 73.7, vfov: 53.1 },
  air3wide: { hfov: 73.7, vfov: 53.1 },
  air3tele: { hfov: 28.3, vfov: 21.4 }
};

/**
 * 지도 초기화 및 이벤트 리스너 등록
 */
function initMap() {
  const savedKey = localStorage.getItem('mapbox_api_key');
  let configKey = null;
  if (typeof MAPBOX_CONFIG !== 'undefined' && MAPBOX_CONFIG.API_KEY) {
    if (MAPBOX_CONFIG.API_KEY.length > 5) {
      configKey = MAPBOX_CONFIG.API_KEY;
    }
  }
  MAPBOX_KEY = savedKey || configKey || "";
  const apiKeyInput = document.getElementById('api-key');
  if (apiKeyInput) {
    if (MAPBOX_KEY) apiKeyInput.value = MAPBOX_KEY;
    apiKeyInput.addEventListener('input', (e) => {
      MAPBOX_KEY = e.target.value;
      localStorage.setItem('mapbox_api_key', MAPBOX_KEY);
      // Mapbox 레이어가 선택되어 있을 경우 타일 업데이트를 위해 페이지 새로고침 권장
    });
  }

  // 기본 세팅: 한국 중심 좌표 (성남시 분당구 서현역 부근)
  map = L.map('map').setView([37.3849, 127.1229], 16);
  
  const baseLayers = {
    '구글 위성 하이브리드': L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      maxZoom: 20,
      attribution: 'Google Hybrid'
    }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }),
    'Mapbox 위성 이미지': L.tileLayer('https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/256/{z}/{x}/{y}?access_token=' + (MAPBOX_KEY || 'dummy_token'), {
      maxZoom: 20,
      attribution: '© Mapbox'
    })
  };

  // 구글 위성 지도를 기본값으로 설정
  baseLayers['구글 위성 하이브리드'].addTo(map);
  L.control.layers(baseLayers, null, { collapsed: true }).addTo(map);

  // 그리기(Draw) 영역 관리용 그룹 추가
  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);
  
  const drawControl = new L.Control.Draw({
    edit: {
      featureGroup: drawnItems
    },
    draw: {
      polygon: {
        allowIntersection: false,
        showArea: true,
        shapeOptions: {
          color: '#00e5ff',
          fillColor: '#00e5ff',
          fillOpacity: 0.15,
          weight: 3
        }
      },
      polyline: false,
      circle: false,
      marker: false,
      circlemarker: false,
      rectangle: false
    }
  });
  map.addControl(drawControl);

  // 다각형 그리기 완료 이벤트 바인딩
  map.on(L.Draw.Event.CREATED, (e) => {
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    currentPolygon = e.layer.toGeoJSON();
    updateMissionInfo();
  });

  // 마우스 이동 시 좌표 실시간 갱신
  map.on('mousemove', (e) => {
    const coordDisp = document.getElementById('coord-display');
    if (coordDisp) {
      coordDisp.innerText = `위도: ${e.latlng.lat.toFixed(6)}, 경도: ${e.latlng.lng.toFixed(6)}`;
    }
  });
}

/**
 * Open-Meteo Elevation API
 * 위도/경도 목록을 50개씩 청크 분할하여 고도 데이터를 대량 쿼리
 */
async function fetchElevationsBatch(coords) {
  if (!coords || coords.length === 0) return [];

  const btn = document.getElementById('btn-generate');
  const originalText = btn ? btn.innerText : "";

  const results = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < coords.length; i += BATCH_SIZE) {
    if (btn) btn.innerText = `지형 수집 중... (${Math.round((i / coords.length) * 100)}%)`;

    const chunk = coords.slice(i, i + BATCH_SIZE);
    const lats = chunk.map(c => c.lat.toFixed(6)).join(',');
    const lngs = chunk.map(c => c.lng.toFixed(6)).join(',');

    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (data.elevation) {
        results.push(...data.elevation);
      } else {
        results.push(...chunk.map(() => 0));
      }
    } catch (e) {
      console.error("지형 고도 Fetch 실패:", e);
      results.push(...chunk.map(() => 0));
    }

    // 서버 부하 경감을 위한 가벼운 슬립
    await new Promise(resolve => setTimeout(resolve, 80));
  }

  if (btn) btn.innerText = originalText;
  return results;
}

/**
 * 드론 모델 및 카메라 설정에 따른 비행 종/횡중복 매핑 그리드 알고리즘
 */
function generateGrid() {
  if (!currentPolygon) return;

  const h = parseFloat(document.getElementById('flight-height').value) || 100;
  const fOv = parseFloat(document.getElementById('front-overlap').value) || 80;
  const sOv = parseFloat(document.getElementById('side-overlap').value) || 70;

  // 드론 설정 확인
  const modelSelect = document.getElementById('drone-model');
  const selectedModel = modelSelect.value;
  
  let hfov, vfov;
  if (selectedModel === 'custom') {
    hfov = parseFloat(document.getElementById('camera-hfov').value) || 73.7;
    vfov = parseFloat(document.getElementById('camera-vfov').value) || 53.1;
  } else {
    const spec = DRONE_PRESETS[selectedModel] || DRONE_PRESETS.mini4pro;
    hfov = spec.hfov;
    vfov = spec.vfov;
  }

  // 지면 커버리지 너비/높이 계산 (삼각비 이용)
  const groundWidth = 2 * h * Math.tan((hfov / 2) * Math.PI / 180);
  const groundHeight = 2 * h * Math.tan((vfov / 2) * Math.PI / 180);

  // 중복률 기준 실 비행 이동 간격 (미터 단위)
  // Side Overlap (횡중복) -> 비행 경로 간격(가로)
  // Front Overlap (종중복) -> 비행 경로 내부 촬영 점 간격(세로)
  const spacingX = groundWidth * (1 - sOv / 100);
  const spacingY = groundHeight * (1 - fOv / 100);

  const overlapInfo = document.getElementById('overlap-info');
  if (overlapInfo) {
    overlapInfo.innerText = `산출 간격: 경로 간(가로) ${spacingX.toFixed(1)}m / 촬영 간(세로) ${spacingY.toFixed(1)}m`;
  }

  // Turf.js 다각형 Bounding Box 계산
  const bbox = turf.bbox(currentPolygon);
  const centerLat = (bbox[1] + bbox[3]) / 2;

  // 위/경도 단위의 스텝값 계산 (위도 1도 = 약 111,111m 기준)
  const latStep = spacingY / 111111;
  const lngStep = spacingX / (111111 * Math.cos(centerLat * Math.PI / 180));

  let rows = [];
  for (let lat = bbox[1]; lat <= bbox[3] + latStep; lat += latStep) {
    let row = [];
    for (let lng = bbox[0]; lng <= bbox[2] + lngStep; lng += lngStep) {
      const pt = turf.point([lng, lat]);
      // 그린 영역 다각형 내부에 포함된 지점인지 필터링
      if (turf.booleanPointInPolygon(pt, currentPolygon)) {
        row.push({ lat, lng });
      }
    }
    if (row.length > 0) rows.push(row);
  }

  // S자(지그재그) 비행을 위한 인접 경로 역정렬
  waypoints = [];
  rows.forEach((row, index) => {
    if (index % 2 === 1) {
      row.reverse();
    }
    waypoints.push(...row);
  });

  // 웨이포인트 숫자 카운트 표시 및 버튼 해제
  document.getElementById('wp-count').innerText = waypoints.length + " 개";
  document.getElementById('btn-generate').disabled = (waypoints.length === 0);
  document.getElementById('btn-preview-kml').disabled = (waypoints.length === 0);

  // 전체 예상 비행 거리 계산
  let totalDistMeters = 0;
  try {
    if (waypoints && waypoints.length > 1) {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const p1 = [waypoints[i].lng, waypoints[i].lat];
        const p2 = [waypoints[i + 1].lng, waypoints[i + 1].lat];
        totalDistMeters += turf.distance(p1, p2, { units: 'kilometers' }) * 1000;
      }
    }
  } catch (e) {
    console.error("거리 환산 에러:", e);
  }

  const flightSpeed = parseFloat(document.getElementById('flight-speed').value) || 5;
  // 속도에 따른 비행시간 + 웨이포인트 정지 가중치 (기본 2초 추가)
  const totalSeconds = (totalDistMeters / flightSpeed) + (waypoints.length * 2);
  const totalMinutes = Math.max(1, Math.ceil(totalSeconds / 60));

  const totalDistElem = document.getElementById('total-distance');
  const estTimeElem = document.getElementById('est-time');

  if (totalDistElem) {
    totalDistElem.innerText = (totalDistMeters / 1000).toFixed(2) + " km";
  }

  if (estTimeElem) {
    estTimeElem.innerText = waypoints.length > 0 ? `약 ${totalMinutes}분` : "-";
    // 예상 시간이 배터리 한계선인 25분을 상회하는 경우 경고 스타일 표시
    if (totalMinutes > 25) {
      estTimeElem.style.color = "#ff4d4d";
      estTimeElem.title = "안전을 위해 배터리 1개 팩 분량을 초과합니다. 영역을 분할해주세요.";
    } else {
      estTimeElem.style.color = "#00e5ff";
      estTimeElem.title = "";
    }
  }

  // 이전 비행 경로용 레이어 초기화 (다각형 영역 본체는 유지)
  drawnItems.eachLayer(l => {
    if (l instanceof L.Polyline && !(l instanceof L.Polygon)) {
      drawnItems.removeLayer(l);
    }
    if (l instanceof L.CircleMarker) {
      drawnItems.removeLayer(l);
    }
  });

  // 지도 위 S자 가상 비행선 연결 그리기
  if (waypoints.length > 1) {
    const latlngs = waypoints.map(wp => [wp.lat, wp.lng]);
    L.polyline(latlngs, {
      color: '#00e5ff',
      weight: 2.5,
      dashArray: '5, 8',
      opacity: 0.8
    }).addTo(drawnItems);
  }

  // 비행 웨이포인트 지점 마커 플로팅
  waypoints.forEach((wp, i) => {
    // 시작점: 빨간색, 종료점: 초록색, 그 외: 네온 블루
    const color = (i === 0) ? '#ff4d4d' : (i === waypoints.length - 1 ? '#4caf50' : '#00e5ff');
    L.circleMarker([wp.lat, wp.lng], {
      radius: 4,
      color: color,
      fillColor: color,
      fillOpacity: 0.9,
      weight: 1
    }).addTo(drawnItems);
  });
}

/**
 * 다각형 영역 설정 시 실시간 면적 환산
 */
function updateMissionInfo() {
  if (!currentPolygon) return;
  const area = turf.area(currentPolygon);
  document.getElementById('area-size').innerText = (area / 1000000).toFixed(3) + " km²";
  generateGrid();
}

/**
 * 로컬 파일 가상 링크 다운로드 브릿지
 */
function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }, 100);
}

/**
 * DJI 스마트 조종기용 Waypoints V3 구조 KMZ 압축 패키지 내보내기
 */
async function createKMZ() {
  const btn = document.getElementById('btn-generate');
  const originalText = btn.innerText;
  btn.innerText = "지형 조회 중...";
  btn.disabled = true;

  try {
    const h = parseFloat(document.getElementById('flight-height').value) || 100;
    const speed = parseFloat(document.getElementById('flight-speed').value) || 5;
    const zip = new JSZip();
    
    // 지형 고도(DEM) 쿼리
    const elevations = await fetchElevationsBatch(waypoints);
    // 상대 고도에 지형 해발고도를 더해 절대 고도 WGS84 높이 생성
    const evWPs = waypoints.map((wp, i) => ({
      ...wp,
      alt: (elevations[i] || 0) + h
    }));

    const wpmz = zip.folder("wpmz");
    const now = new Date();
    const missionName = `Mission_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;

    // 1. DJI template.kml 파일 주입
    const template = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.3">
  <Document>
    <wpml:author>ShinguDronePlanner</wpml:author>
    <wpml:missionName>${missionName}</wpml:missionName>
    <wpml:createTime>${Date.now()}</wpml:createTime>
    <wpml:updateTime>${Date.now()}</wpml:updateTime>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>goHome</wpml:exitOnRCLost>
      <wpml:executeHeightMode>WGS84</wpml:executeHeightMode>
      <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${speed}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>68</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>0</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>
  </Document>
</kml>`;
    wpmz.file("template.kml", template);

    // 2. DJI 실질 비행 경로 정보 waylines.wpml 주입
    const waylines = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.3">
  <Document>
    <wpml:author>ShinguDronePlanner</wpml:author>
    <wpml:missionName>${missionName}</wpml:missionName>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>goHome</wpml:exitOnRCLost>
      <wpml:executeHeightMode>WGS84</wpml:executeHeightMode>
      <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${speed}</wpml:globalTransitionalSpeed>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>
      <wpml:actionGroup>
        <wpml:actionGroupId>0</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>0</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${evWPs.length - 1}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
        </wpml:actionTrigger>
        <wpml:action>
          <wpml:actionId>0</wpml:actionId>
          <wpml:actionActuatorFunc>gimbalPitch</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:gimbalPitchAngle>-90</wpml:gimbalPitchAngle>
          </wpml:actionActuatorFuncParam>
        </wpml:action>
        <wpml:action>
          <wpml:actionId>1</wpml:actionId>
          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>
      </wpml:actionGroup>
      ${evWPs.map((wp, i) => `
      <Placemark>
        <Point>
          <coordinates>${wp.lng.toFixed(7)},${wp.lat.toFixed(7)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${wp.alt.toFixed(2)}</wpml:executeHeight>
        <wpml:waypointSpeed>${speed}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
        </wpml:waypointHeadingParam>
        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>
        <wpml:useGlobalSpeed>1</wpml:useGlobalSpeed>
        <wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>
      </Placemark>`).join('')}
    </Folder>
  </Document>
</kml>`;
    wpmz.file("waylines.wpml", waylines);

    const content = await zip.generateAsync({ type: "blob" });
    const formattedDate = now.toISOString().slice(0, 10).replace(/-/g, "");
    downloadFile(content, `DroneMission_${formattedDate}.kmz`, "application/vnd.google-earth.kmz");
  } catch (err) {
    console.error("KMZ 빌드 에러:", err);
    alert("KMZ 파일 생성에 실패했습니다. 입력값을 재확인해주세요.");
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

/**
 * 3D 구글어스 검토용 일반 KML 파일 내보내기
 */
async function exportKML() {
  const btn = document.getElementById('btn-preview-kml');
  const originalText = btn.innerText;
  btn.innerText = "조회 중...";
  btn.disabled = true;

  try {
    const h = parseFloat(document.getElementById('flight-height').value) || 100;
    const elevations = await fetchElevationsBatch(waypoints);
    const evWPs = waypoints.map((wp, i) => ({
      ...wp,
      alt: (elevations[i] || 0) + h
    }));

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Drone Flight Preview</name>
    <Style id="yellowLineGreenPoly">
      <LineStyle>
        <color>7f00ffff</color>
        <width>4</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>3D Flight Path</name>
      <styleUrl>#yellowLineGreenPoly</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
          ${evWPs.map(wp => `${wp.lng.toFixed(7)},${wp.lat.toFixed(7)},${wp.alt.toFixed(2)}`).join('\n')}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
    const now = new Date();
    const formattedDate = now.toISOString().slice(0, 10).replace(/-/g, "");
    downloadFile(kml, `PathPreview_${formattedDate}.kml`, "application/vnd.google-earth.kml+xml");
  } catch (err) {
    alert("KML 내보내기에 오류가 발생했습니다.");
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

/**
 * DJI 조종기 저장 패스 자동 복사 기능
 */
function copyPath() {
  const path = "DJI/dji.go.v5/Waypoints/";
  navigator.clipboard.writeText(path).then(() => {
    alert("경로가 클립보드에 복사되었습니다: " + path);
  }).catch(err => {
    console.error("경로 복사 실패:", err);
  });
}

/**
 * 드론 모델 사전 프리셋 변경 처리기
 */
function handleDroneModelChange() {
  const modelSelect = document.getElementById('drone-model');
  const customInputs = document.getElementById('custom-camera-inputs');
  
  if (modelSelect.value === 'custom') {
    customInputs.style.display = 'flex';
  } else {
    customInputs.style.display = 'none';
  }
  generateGrid();
}

/**
 * DOM 콘텐츠 로드 완료 후 리스너 대입
 */
document.addEventListener('DOMContentLoaded', () => {
  // 모바일 사이드바 제어 리스너
  const sidebar = document.getElementById('sidebar');
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const btnSidebarClose = document.getElementById('btn-sidebar-close');

  if (btnSidebarToggle && sidebar) {
    btnSidebarToggle.addEventListener('click', () => {
      sidebar.classList.add('active');
    });
  }

  if (btnSidebarClose && sidebar) {
    btnSidebarClose.addEventListener('click', () => {
      sidebar.classList.remove('active');
    });
  }

  // 모바일 오버레이 바텀시트 슬라이딩 제어
  const overlayControls = document.getElementById('overlay-controls');
  const sheetHandle = document.getElementById('sheet-handle');

  if (sheetHandle && overlayControls) {
    sheetHandle.addEventListener('click', () => {
      overlayControls.classList.toggle('collapsed');
    });
  }

  // 드론 설정 및 핵심 필드 리스너 연동
  document.getElementById('drone-model').addEventListener('change', handleDroneModelChange);
  document.getElementById('camera-hfov').addEventListener('input', generateGrid);
  document.getElementById('camera-vfov').addEventListener('input', generateGrid);
  document.getElementById('flight-height').addEventListener('input', generateGrid);
  document.getElementById('front-overlap').addEventListener('input', generateGrid);
  document.getElementById('side-overlap').addEventListener('input', generateGrid);
  document.getElementById('flight-speed').addEventListener('input', generateGrid);

  // 결과 생성 버튼 리스너 연동
  document.getElementById('btn-generate').addEventListener('click', createKMZ);
  document.getElementById('btn-preview-kml').addEventListener('click', exportKML);
});
