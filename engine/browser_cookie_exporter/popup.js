const korean = navigator.language.toLowerCase().startsWith('ko');
const words = korean ? {
  help: 'Lanius 설정에서 발급한 일회용 코드를 입력하면 이 브라우저 프로필의 쿠키를 이 컴퓨터의 Lanius로 보냅니다.',
  code: 'Lanius 일회용 코드', send: '쿠키 보내기', invalid: '코드를 확인하세요.',
  working: '쿠키를 보내는 중…', done: '전송했습니다. Lanius에서 결과를 확인하세요.',
  failed: '전송에 실패했습니다. Lanius가 실행 중인지 확인하세요.',
} : {
  help: 'Enter the one-time code from Lanius Settings to send this browser profile’s cookies to Lanius on this computer.',
  code: 'Lanius one-time code', send: 'Send cookies', invalid: 'Check the code.',
  working: 'Sending cookies…', done: 'Sent. Check Lanius for the result.',
  failed: 'Transfer failed. Check that Lanius is running.',
};

document.querySelector('#help').textContent = words.help;
document.querySelector('#code-label').textContent = words.code;
document.querySelector('#send').textContent = words.send;

document.querySelector('#send').addEventListener('click', async () => {
  const input = document.querySelector('#code');
  const status = document.querySelector('#status');
  const match = /^(\d{1,5}):([A-Za-z0-9_-]{24,})$/.exec(input.value.trim());
  const port = match ? Number(match[1]) : 0;
  if (!match || port < 1 || port > 65535) {
    status.textContent = words.invalid;
    return;
  }
  document.querySelector('#send').disabled = true;
  status.textContent = words.working;
  try {
    const cookies = await chrome.cookies.getAll({});
    // A no-CORS, text/plain POST needs no broad API CORS permission. Lanius
    // accepts it only with the short-lived code shown in its own window.
    await fetch(`http://127.0.0.1:${port}/api/browser/cookies/extension-import`, {
      method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ code: match[2], cookies }),
    });
    input.value = '';
    status.textContent = words.done;
  } catch {
    status.textContent = words.failed;
  } finally {
    document.querySelector('#send').disabled = false;
  }
});
