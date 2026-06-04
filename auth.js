/**
 * DronePlanner - Simple Authentication Script
 * SHA-256 해시를 이용한 로컬 로그인 모듈입니다.
 */

const AUTH_CONFIG = {
    EXPECTED_USER: 'user',
    // 비밀번호 'user2685'의 SHA-256 해시값
    EXPECTED_PASS_HASH: '2ce7c4e813cdec5d49d684e60c591c24f5ad0c3d1e174fe9fd5cb7161047983d'
};

/**
 * SHA-256 해싱 함수 (브라우저 SubtleCrypto API 활용)
 */
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 로그인 확인 함수
 */
async function checkLogin() {
    const username = document.getElementById('login-user').value;
    const password = document.getElementById('login-pass').value;
    const errorMsg = document.getElementById('login-error');

    const passHash = await sha256(password);

    if (username === AUTH_CONFIG.EXPECTED_USER && passHash === AUTH_CONFIG.EXPECTED_PASS_HASH) {
        // 로그인 성공: 브라우저 세션 스토리지에 인증 플래그 기록
        sessionStorage.setItem('drone_planner_auth', 'true');
        document.getElementById('login-overlay').style.display = 'none';

        // 지도 초기화 실행
        if (typeof initMap === 'function') {
            initMap();
        }
    } else {
        errorMsg.innerText = "아이디 또는 비밀번호가 올바르지 않습니다.";
        errorMsg.style.display = 'block';
    }
}

// 엔터키 입력 지원
function handleLoginKeyup(event) {
    if (event.key === 'Enter') {
        checkLogin();
    }
}

// 페이지 로드 시 로그인 상태 체크 (즉시 지도 사용이 가능하도록 로그인 자동 바이패스)
document.addEventListener('DOMContentLoaded', () => {
    const loginOverlay = document.getElementById('login-overlay');
    if (loginOverlay) loginOverlay.style.display = 'none';
    if (typeof initMap === 'function') {
        initMap();
    }
});
