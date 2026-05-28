/**
 * Phone layout: slide-out sidebar overlay (iPhone / Android portrait).
 * Loaded on every page via partials/foot.ejs.
 */
(function () {
  const app = document.querySelector('.app');
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggle = document.getElementById('mobile-nav-btn');
  if (!app || !sidebar || !backdrop || !toggle) return;

  const MQ = window.matchMedia('(max-width: 639px)');

  function isPhone() {
    return MQ.matches;
  }

  function setOpen(open) {
    const on = Boolean(open) && isPhone();
    app.classList.toggle('is-sidebar-open', on);
    document.body.classList.toggle('is-sidebar-open', on);
    toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    toggle.setAttribute('aria-label', on ? 'Close menu' : 'Open menu');
    backdrop.hidden = !on;
    backdrop.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function openSidebar() {
    setOpen(true);
  }

  function closeSidebar() {
    setOpen(false);
  }

  function toggleSidebar() {
    setOpen(!app.classList.contains('is-sidebar-open'));
  }

  toggle.addEventListener('click', function () {
    toggleSidebar();
  });

  backdrop.addEventListener('click', closeSidebar);

  sidebar.addEventListener('click', function (ev) {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (!t.closest('a[href]')) return;
    closeSidebar();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeSidebar();
  });

  MQ.addEventListener('change', function () {
    if (!isPhone()) closeSidebar();
  });

  window.addEventListener('resize', function () {
    if (!isPhone()) closeSidebar();
  });
})();
