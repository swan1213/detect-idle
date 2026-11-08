// Presence check card. The countdown length comes from the main process (?seconds=60).
// The main process closes this window when the freelancer confirms (button, real mouse
// movement or typing) or when time runs out.
const seconds = Number(new URLSearchParams(location.search).get('seconds')) || 60;
document.getElementById('timer').style.animation = `drain ${seconds}s linear forwards`;
document.getElementById('here').onclick = () => {
  document.getElementById('card').classList.add('out');
  window.api.presenceConfirm();
};
