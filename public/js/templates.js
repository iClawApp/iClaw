(function () {
  'use strict';

  const searchInput = document.getElementById('templates-search');
  const gallery = document.getElementById('templates-gallery');
  const emptyState = document.getElementById('templates-gallery-empty');
  const flashEl = document.getElementById('templates-flash');

  const wizardModal = document.getElementById('template-wizard-modal');
  const wizardForm = document.getElementById('template-wizard-form');
  const wizardFields = document.getElementById('template-wizard-fields');
  const wizardTitle = document.getElementById('template-wizard-title');
  const wizardSubtitle = document.getElementById('template-wizard-subtitle');
  const wizardError = document.getElementById('template-wizard-error');
  const wizardSubmit = document.getElementById('template-wizard-submit');

  const createModal = document.getElementById('template-create-modal');
  const createForm = document.getElementById('template-create-form');
  const createError = document.getElementById('template-create-error');
  const createSubmit = document.getElementById('template-create-submit');
  const addBtn = document.getElementById('templates-add-btn');

  if (!gallery) return;

  let activeTemplateId = null;
  let openModalEl = null;

  (function showQueryFlash() {
    if (!flashEl) return;
    const params = new URLSearchParams(window.location.search);
    const createdTitle = params.get('createdTitle');
    const error = params.get('error');
    if (createdTitle) {
      flashEl.hidden = false;
      flashEl.className = 'templates-flash templates-flash--ok';
      flashEl.textContent = 'Role «' + decodeURIComponent(createdTitle) + '» saved.';
      window.history.replaceState({}, '', '/templates');
    } else if (error) {
      flashEl.hidden = false;
      flashEl.className = 'templates-flash templates-flash--err';
      flashEl.textContent = decodeURIComponent(error);
      window.history.replaceState({}, '', '/templates');
    }
  })();

  function setModal(modal, open) {
    if (!modal) return;
    if (open) {
      if (openModalEl && openModalEl !== modal) setModal(openModalEl, false);
      modal.hidden = false;
      document.body.classList.add('modal-open');
      openModalEl = modal;
    } else {
      modal.hidden = true;
      if (openModalEl === modal) {
        openModalEl = null;
        document.body.classList.remove('modal-open');
      }
    }
  }

  function closeWizard() {
    setModal(wizardModal, false);
    activeTemplateId = null;
    if (wizardFields) wizardFields.innerHTML = '';
    if (wizardError) {
      wizardError.hidden = true;
      wizardError.textContent = '';
    }
  }

  function closeCreate() {
    setModal(createModal, false);
    if (createError) {
      createError.hidden = true;
      createError.textContent = '';
    }
  }

  function parseAsk(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function renderField(field) {
    const wrap = document.createElement('label');
    wrap.className = 'template-wizard-field';

    const caption = document.createElement('span');
    caption.className = 'template-wizard-field__label';
    caption.textContent = field.label || field.key;
    wrap.appendChild(caption);

    if (field.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
      const select = document.createElement('select');
      select.name = field.key;
      select.required = true;
      select.className = 'template-wizard-field__input';
      for (const opt of field.options) {
        const option = document.createElement('option');
        option.value = opt;
        option.textContent = opt;
        select.appendChild(option);
      }
      wrap.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = field.key;
      input.className = 'template-wizard-field__input';
      input.autocomplete = 'off';
      input.spellcheck = false;
      wrap.appendChild(input);
    }

    return wrap;
  }

  function openWizard(card) {
    const templateId = card.getAttribute('data-template-id');
    const title = card.getAttribute('data-title') || 'Role';
    const ask = parseAsk(card.getAttribute('data-ask'));

    activeTemplateId = templateId;

    if (ask.length === 0) {
      activateTemplate(templateId, {});
      return;
    }

    if (wizardTitle) wizardTitle.textContent = title;
    if (wizardSubtitle) wizardSubtitle.textContent = '';
    if (wizardFields) {
      wizardFields.innerHTML = '';
      for (const field of ask) {
        wizardFields.appendChild(renderField(field));
      }
    }
    setModal(wizardModal, true);
    const firstInput = wizardFields && wizardFields.querySelector('input, select');
    if (firstInput) firstInput.focus();
  }

  async function activateTemplate(templateId, answers) {
    if (!templateId) return;
    if (wizardSubmit) wizardSubmit.disabled = true;
    if (wizardError) {
      wizardError.hidden = true;
      wizardError.textContent = '';
    }
    try {
      const res = await fetch('/templates/activate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ templateId, answers }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        throw new Error(data.error || 'Failed to activate');
      }
      if (data.chatId) {
        window.location.href = '/chats/' + data.chatId;
        return;
      }
      throw new Error('No chatId in response');
    } catch (err) {
      if (wizardError) {
        wizardError.hidden = false;
        wizardError.textContent = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (wizardSubmit) wizardSubmit.disabled = false;
    }
  }

  function buildCreatePayload() {
    return {
      title: String(createForm.querySelector('[name="title"]')?.value ?? '').trim(),
      promptTemplate: String(createForm.querySelector('[name="promptTemplate"]')?.value ?? '').trim(),
      category: String(createForm.querySelector('[name="category"]')?.value ?? '').trim(),
    };
  }

  async function submitCreate(e) {
    e.preventDefault();
    if (!createForm) return;
    if (createSubmit) createSubmit.disabled = true;
    if (createError) {
      createError.hidden = true;
      createError.textContent = '';
    }
    try {
      const res = await fetch('/templates/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(buildCreatePayload()),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        throw new Error(data.error || 'Failed to publish');
      }
      window.location.href =
        '/templates?createdTitle=' + encodeURIComponent(data.title || '');
    } catch (err) {
      if (createError) {
        createError.hidden = false;
        createError.textContent = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (createSubmit) createSubmit.disabled = false;
    }
  }

  let activeTools = [];
  function filterCards() {
    const q = (searchInput ? searchInput.value : '').trim().toLowerCase();
    let visible = 0;
    gallery.querySelectorAll('.template-card').forEach(function (card) {
      const blob = (card.getAttribute('data-search') || '').toLowerCase();
      const tools = (card.getAttribute('data-tools') || '').toLowerCase();
      const toolList = tools ? tools.split('|') : [];
      const matchText = !q || blob.indexOf(q) >= 0;
      const matchTool =
        activeTools.length === 0 ||
        activeTools.some(function (t) {
          return toolList.indexOf(t) >= 0;
        });
      const show = matchText && matchTool;
      card.hidden = !show;
      if (show) visible += 1;
    });

    gallery.querySelectorAll('.templates-gallery-section').forEach(function (section) {
      section.hidden = !section.querySelector('.template-card:not([hidden])');
    });

    if (emptyState) emptyState.hidden = visible > 0 || (!q && activeTools.length === 0);
  }

  gallery.addEventListener('click', function (e) {
    const btn = e.target.closest('.template-card-activate');
    if (!btn) return;
    const card = btn.closest('.template-card');
    if (card) openWizard(card);
  });

  if (searchInput) {
    searchInput.addEventListener('input', filterCards);
  }

  // Tool filter — multi-select dropdown (a role matches if it has ANY selected tool).
  (function setupToolDropdown() {
    const dd = document.getElementById('tool-dropdown');
    if (!dd) return;
    const toggle = document.getElementById('tool-dropdown-toggle');
    const panel = document.getElementById('tool-dropdown-panel');
    const label = document.getElementById('tool-dropdown-label');
    const boxes = Array.prototype.slice.call(panel.querySelectorAll('.tool-filter-cb'));

    function setOpen(open) {
      panel.hidden = !open;
      dd.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function labelFor(value) {
      const box = boxes.find(function (b) { return b.value === value; });
      const span = box && box.parentElement.querySelector('span');
      return span ? span.textContent : value;
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(panel.hidden);
    });
    document.addEventListener('click', function (e) {
      if (!dd.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });

    boxes.forEach(function (cb) {
      cb.addEventListener('change', function () {
        activeTools = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
        if (activeTools.length === 0) label.textContent = 'Усі інструменти';
        else if (activeTools.length === 1) label.textContent = labelFor(activeTools[0]);
        else label.textContent = activeTools.length + ' інструменти';
        dd.classList.toggle('has-selection', activeTools.length > 0);
        filterCards();
      });
    });
  })();

  if (wizardForm) {
    wizardForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!activeTemplateId) return;
      const answers = {};
      wizardForm.querySelectorAll('input[name], select[name]').forEach(function (el) {
        answers[el.name] = el.value;
      });
      activateTemplate(activeTemplateId, answers);
    });
  }

  if (createForm) {
    createForm.addEventListener('submit', submitCreate);
  }

  if (addBtn) {
    addBtn.addEventListener('click', function () {
      if (createForm) createForm.reset();
      setModal(createModal, true);
      const first = createForm && createForm.querySelector('[name="title"]');
      if (first) first.focus();
    });
  }

  document.querySelectorAll('.template-wizard-cancel').forEach(function (btn) {
    btn.addEventListener('click', closeWizard);
  });
  document.querySelectorAll('.template-wizard-backdrop').forEach(function (el) {
    el.addEventListener('click', closeWizard);
  });

  document.querySelectorAll('.template-create-cancel').forEach(function (btn) {
    btn.addEventListener('click', closeCreate);
  });
  document.querySelectorAll('.template-create-backdrop').forEach(function (el) {
    el.addEventListener('click', closeCreate);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !openModalEl) return;
    if (openModalEl === wizardModal) closeWizard();
    else if (openModalEl === createModal) closeCreate();
  });
})();
