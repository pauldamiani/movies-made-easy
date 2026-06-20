// Movies Made Easy — front-end
// Bucket 1: movie-first view (box-art grid → sessions by cinema → book).
// Bucket 2: day selection (pill strip), refetch on change.
// Bucket 3: cinema selection (multi-select picker, persisted).
// Bucket 4: window prefetch + cache, persistent movie filter, upcoming-movies strip.

const statusEl = document.getElementById('status');
const gridEl = document.getElementById('grid');
const contextEl = document.getElementById('context');
const dayStripEl = document.getElementById('dayStrip');

const cinemaBtnEl = document.getElementById('cinemaBtn');
const cinemaBtnLabelEl = document.getElementById('cinemaBtnLabel');
const cinemaModalEl = document.getElementById('cinemaModal');
const cinemaListEl = document.getElementById('cinemaList');
const cinemaSearchEl = document.getElementById('cinemaSearch');
const cinemaCountEl = document.getElementById('cinemaCount');
const cinemaApplyEl = document.getElementById('cinemaApply');

const movieBtnEl = document.getElementById('movieFilterBtn');
const movieBtnLabelEl = document.getElementById('movieFilterLabel');
const movieModalEl = document.getElementById('movieModal');
const movieListEl = document.getElementById('movieList');
const movieSearchEl = document.getElementById('movieSearch');
const movieCountEl = document.getElementById('movieCount');
const movieApplyEl = document.getElementById('movieApply');
const movieClearEl = document.getElementById('movieClear');

const upcomingEl = document.getElementById('upcoming');
const upcomingStripEl = document.getElementById('upcomingStrip');

const collapseBtnEl = document.getElementById('collapseBtn');
const collapseLabelEl = document.getElementById('collapseLabel');
const typeChipsEl = document.getElementById('typeChips');

let currentDate = null; // the date being viewed (YYYY-MM-DD); resolved after first load
let builtDatesKey = ''; // signature of the strip currently rendered
let todayStr = null; // the cinemas' "today" (Sydney), from the proxy's X-Today header

let cinemas = []; // baked roster: [{id, name, state}]
let selectedCinemaIds = []; // currently active cinema ids
let cinemaWorking = new Set(); // working set while the cinema modal is open

// Window prefetch/cache — the whole today→+10 window for the selected cinemas.
const windowCache = new Map(); // dateStr -> { data, source }
let windowDates = []; // [today .. today+10]
let windowLoading = false;
const movieCatalog = new Map(); // movieId -> { id, name, poster }
const firstDateByMovie = new Map(); // movieId -> { id, name, poster, firstDate }

// Movie filter — selected movie ids; empty Set means "show all".
let movieFilter = new Set();
let movieWorking = new Set(); // working set while the movie modal is open

// View refinements (in-memory; reset on reload).
let allCollapsed = false; // collapse-all toggle for movie cards
let typeFilter = new Set(); // selected session-type names; empty => all
const availableTypes = new Set(); // session types present across the window

const MAX_DAYS = 11; // today + next 10 days
const DEFAULT_CINEMA_IDS = [65, 94]; // Campbelltown, Ed Square — the usual two
const CINEMA_STORAGE_KEY = 'mme.cinemaIds';
const MOVIE_STORAGE_KEY = 'mme.movieFilter';
const PREFETCH_BATCH = 3; // gentle concurrency for the background window fetch
const LOW_SEATS = 20; // at/under this many seats → flagged as running low
const SOON_MINUTES = 60; // today's sessions starting within this window → "Soon"
const TYPE_ORDER = ['Gold Class', 'V-Max', 'Boutique', 'ScreenX', 'Original'];

const STATE_ORDER = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'NT', 'TAS'];
const STATE_NAMES = {
  NSW: 'New South Wales',
  ACT: 'ACT',
  VIC: 'Victoria',
  QLD: 'Queensland',
  SA: 'South Australia',
  WA: 'Western Australia',
  NT: 'Northern Territory',
  TAS: 'Tasmania',
};

// --- formatting helpers -----------------------------------------------------

// StartTime is wall-clock with no timezone, e.g. "2026-06-19T18:00".
function formatTime(startTime) {
  const time = (startTime.split('T')[1] || '').slice(0, 5);
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function parseDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

// Add n days to a YYYY-MM-DD string, staying in local time (no UTC shift).
function addDays(dateStr, n) {
  const dt = parseDate(dateStr);
  dt.setDate(dt.getDate() + n);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLong(dateStr) {
  return parseDate(dateStr).toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// Short label for upcoming cards, e.g. "Tomorrow" or "Thu 25 Jun".
function formatShortDate(dateStr) {
  if (todayStr && dateStr === addDays(todayStr, 1)) return 'Tomorrow';
  const dt = parseDate(dateStr);
  const wd = dt.toLocaleDateString('en-AU', { weekday: 'short' });
  const dm = dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return `${wd} ${dm}`;
}

function seatsLabel(n) {
  return `${n} ${n === 1 ? 'seat' : 'seats'}`;
}

// --- session refinement helpers --------------------------------------------

function sessionMatchesType(s) {
  return !typeFilter.size || typeFilter.has(s.ScreenTypeName);
}

function movieMatchesType(movie) {
  return (movie.CinemaModels || []).some((cm) => (cm.Sessions || []).some(sessionMatchesType));
}

// True for today's sessions starting within the next SOON_MINUTES.
// Uses the browser's local clock (Sydney for the intended audience).
function isSoon(startTime) {
  if (currentDate !== todayStr) return false;
  const [h, m] = (startTime.split('T')[1] || '').slice(0, 5).split(':').map(Number);
  const start = new Date();
  start.setHours(h, m, 0, 0);
  const diffMin = (start - new Date()) / 60000;
  return diffMin >= 0 && diffMin <= SOON_MINUTES;
}

// --- date bar ---------------------------------------------------------------

function pillLabels(dateStr, index) {
  const dt = parseDate(dateStr);
  // Strip always starts at today, so index 0/1 are genuinely Today/Tomorrow.
  const dow =
    index === 0
      ? 'Today'
      : index === 1
        ? 'Tomorrow'
        : dt.toLocaleDateString('en-AU', { weekday: 'short' });
  const dom = dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return { dow, dom };
}

function renderDateBar(selected) {
  if (!todayStr) return;
  const days = Array.from({ length: MAX_DAYS }, (_, i) => addDays(todayStr, i));

  const key = days.join('|');
  if (key !== builtDatesKey) {
    builtDatesKey = key;
    dayStripEl.innerHTML = '';
    days.forEach((date, i) => {
      const { dow, dom } = pillLabels(date, i);
      const pill = document.createElement('button');
      pill.className = 'day-pill';
      pill.dataset.date = date;
      pill.setAttribute('role', 'tab');
      pill.innerHTML = `<span class="dow">${dow}</span><span class="dom">${dom}</span>`;
      dayStripEl.appendChild(pill);
    });
  }

  let selectedPill = null;
  for (const pill of dayStripEl.children) {
    const isSel = pill.dataset.date === selected;
    pill.classList.toggle('selected', isSel);
    pill.setAttribute('aria-selected', isSel ? 'true' : 'false');
    if (isSel) selectedPill = pill;
  }
  if (selectedPill) selectedPill.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// --- context ----------------------------------------------------------------

function renderContext(data, source) {
  const dateText = data.SelectedDate ? formatDateLong(data.SelectedDate) : '';
  const badge =
    source === 'fallback' ? ' <span class="source-badge">saved sample data</span>' : '';
  contextEl.innerHTML = `${dateText}${badge}`;
}

// --- movie/session card rendering -------------------------------------------

function renderSessions(movie) {
  const wrap = document.createElement('div');
  wrap.className = 'sessions';

  for (const cm of movie.CinemaModels || []) {
    const sessions = [...(cm.Sessions || [])]
      .filter(sessionMatchesType)
      .sort((a, b) => a.StartTime.localeCompare(b.StartTime));
    if (!sessions.length) continue;

    const group = document.createElement('div');
    group.className = 'cinema-group';

    const name = document.createElement('div');
    name.className = 'cinema-name';
    name.textContent = cm.Name;
    group.appendChild(name);

    const list = document.createElement('div');
    list.className = 'session-list';
    for (const s of sessions) {
      const a = document.createElement('a');
      a.className = 'session';
      a.href = s.BookingUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.dataset.type = s.ScreenTypeName || '';
      const low = s.SeatsAvailable <= LOW_SEATS;
      const soon = isSoon(s.StartTime);
      a.innerHTML = `
        <span class="time">${formatTime(s.StartTime)}${soon ? ' <span class="soon-badge">Soon</span>' : ''}</span>
        <span class="type">${s.ScreenTypeName || ''}</span>
        <span class="seats${low ? ' low' : ''}">${low ? `${s.SeatsAvailable} left` : seatsLabel(s.SeatsAvailable)}</span>`;
      list.appendChild(a);
    }
    group.appendChild(list);
    wrap.appendChild(group);
  }
  return wrap;
}

function renderMovie(movie) {
  const card = document.createElement('article');
  card.className = 'movie';
  if (allCollapsed) card.classList.add('collapsed');

  const img = document.createElement('img');
  img.className = 'poster';
  img.src = movie.PosterUrl;
  img.alt = `${movie.Name} poster`;
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    img.replaceWith(
      Object.assign(document.createElement('div'), {
        className: 'poster broken',
        textContent: 'No image',
      })
    );
  });
  card.appendChild(img);

  const body = document.createElement('div');
  body.className = 'movie-body';

  const head = document.createElement('div');
  head.className = 'movie-head';
  const title = document.createElement('h2');
  title.className = 'movie-title';
  title.textContent = movie.Name;
  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.setAttribute('aria-label', 'Toggle sessions');
  toggle.textContent = '▾';
  head.append(title, toggle);
  head.addEventListener('click', () => card.classList.toggle('collapsed'));
  body.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [];
  if (movie.Rating) bits.push(`<span class="pill">${movie.Rating}</span>`);
  if (movie.RunningTime) bits.push(`${movie.RunningTime} min`);
  if (movie.Genres) bits.push(movie.Genres.replace(/,/g, ', '));
  meta.innerHTML = bits.join(' ');
  body.appendChild(meta);

  body.appendChild(renderSessions(movie));
  card.appendChild(body);
  return card;
}

// --- cinema selection -------------------------------------------------------

function cinemaName(id) {
  const c = cinemas.find((x) => x.id === id);
  return c ? c.name : `Cinema ${id}`;
}

function updateCinemaButton() {
  const n = selectedCinemaIds.length;
  cinemaBtnLabelEl.textContent =
    n === 0
      ? 'Select cinemas'
      : n <= 2
        ? selectedCinemaIds.map(cinemaName).join(', ')
        : `${n} cinemas`;
}

function loadSelectedCinemaIds() {
  let ids = null;
  try {
    const raw = localStorage.getItem(CINEMA_STORAGE_KEY);
    if (raw) ids = JSON.parse(raw);
  } catch (_) {
    /* ignore malformed storage */
  }
  const valid = new Set(cinemas.map((c) => c.id));
  ids = Array.isArray(ids) ? ids.filter((id) => valid.has(id)) : [];
  selectedCinemaIds = ids.length ? ids : DEFAULT_CINEMA_IDS.filter((id) => valid.has(id));
}

function persistSelectedCinemaIds() {
  try {
    localStorage.setItem(CINEMA_STORAGE_KEY, JSON.stringify(selectedCinemaIds));
  } catch (_) {
    /* storage may be unavailable; selection still applies this session */
  }
}

function buildCinemaList(filter = '') {
  const q = filter.trim().toLowerCase();
  cinemaListEl.innerHTML = '';
  let shown = 0;
  for (const state of STATE_ORDER) {
    const inState = cinemas
      .filter((c) => c.state === state)
      .filter((c) => !q || c.name.toLowerCase().includes(q));
    if (!inState.length) continue;
    shown += inState.length;

    const group = document.createElement('div');
    group.className = 'state-group';
    const label = document.createElement('div');
    label.className = 'state-label';
    label.textContent = STATE_NAMES[state] || state;
    group.appendChild(label);

    for (const c of inState) {
      const opt = document.createElement('label');
      opt.className = 'cinema-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(c.id);
      cb.checked = cinemaWorking.has(c.id);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = c.name;
      opt.append(cb, nm);
      group.appendChild(opt);
    }
    cinemaListEl.appendChild(group);
  }
  if (!shown) {
    cinemaListEl.innerHTML = '<div class="cinema-empty">No cinemas match your search.</div>';
  }
  updateCinemaFooter();
}

function updateCinemaFooter() {
  cinemaCountEl.textContent = `${cinemaWorking.size} selected`;
  cinemaApplyEl.disabled = cinemaWorking.size === 0;
}

function openCinemaModal() {
  cinemaWorking = new Set(selectedCinemaIds);
  cinemaSearchEl.value = '';
  buildCinemaList('');
  cinemaModalEl.hidden = false;
  cinemaBtnEl.setAttribute('aria-expanded', 'true');
  cinemaSearchEl.focus();
}

function closeCinemaModal() {
  cinemaModalEl.hidden = true;
  cinemaBtnEl.setAttribute('aria-expanded', 'false');
}

function applyCinemaSelection() {
  if (!cinemaWorking.size) return;
  selectedCinemaIds = cinemas.map((c) => c.id).filter((id) => cinemaWorking.has(id));
  persistSelectedCinemaIds();
  updateCinemaButton();
  closeCinemaModal();
  startWindow(); // different cinemas → re-fetch the whole window
}

// --- movie filter -----------------------------------------------------------

function movieName(id) {
  const m = movieCatalog.get(id);
  return m ? m.name : `Movie ${id}`;
}

function updateMovieButton() {
  const n = movieFilter.size;
  movieBtnLabelEl.textContent =
    n === 0
      ? 'All movies'
      : n <= 2
        ? [...movieFilter].map(movieName).join(', ')
        : `${n} movies`;
}

function loadMovieFilter() {
  let ids = null;
  try {
    const raw = localStorage.getItem(MOVIE_STORAGE_KEY);
    if (raw) ids = JSON.parse(raw);
  } catch (_) {
    /* ignore malformed storage */
  }
  movieFilter = new Set(Array.isArray(ids) ? ids.map(Number) : []);
}

function persistMovieFilter() {
  try {
    localStorage.setItem(MOVIE_STORAGE_KEY, JSON.stringify([...movieFilter]));
  } catch (_) {
    /* storage may be unavailable */
  }
}

function buildMovieList(filter = '') {
  const q = filter.trim().toLowerCase();
  movieListEl.innerHTML = '';
  if (!movieCatalog.size) {
    movieListEl.innerHTML = '<div class="cinema-empty">Loading this week’s movies…</div>';
    updateMovieFooter();
    return;
  }
  const all = [...movieCatalog.values()]
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!all.length) {
    movieListEl.innerHTML = '<div class="cinema-empty">No movies match your search.</div>';
    updateMovieFooter();
    return;
  }
  for (const m of all) {
    const opt = document.createElement('label');
    opt.className = 'cinema-option movie-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(m.id);
    cb.checked = movieWorking.has(m.id);
    const img = document.createElement('img');
    img.src = m.poster;
    img.alt = '';
    img.loading = 'lazy';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = m.name;
    opt.append(cb, img, nm);
    movieListEl.appendChild(opt);
  }
  updateMovieFooter();
}

function updateMovieFooter() {
  movieCountEl.textContent = movieWorking.size === 0 ? 'Showing all movies' : `${movieWorking.size} selected`;
}

function openMovieModal() {
  movieWorking = new Set(movieFilter);
  movieSearchEl.value = '';
  buildMovieList('');
  movieModalEl.hidden = false;
  movieBtnEl.setAttribute('aria-expanded', 'true');
  movieSearchEl.focus();
}

function closeMovieModal() {
  movieModalEl.hidden = true;
  movieBtnEl.setAttribute('aria-expanded', 'false');
}

function clearMovieFilter() {
  movieWorking.clear();
  buildMovieList(movieSearchEl.value);
}

function applyMovieFilter() {
  movieFilter = new Set(movieWorking);
  persistMovieFilter();
  updateMovieButton();
  closeMovieModal();
  render(); // client-side only — no refetch needed
}

// --- collapse-all + session-type filter -------------------------------------

function updateCollapseButton() {
  collapseLabelEl.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
}

function toggleCollapseAll() {
  allCollapsed = !allCollapsed;
  for (const card of gridEl.querySelectorAll('.movie')) {
    card.classList.toggle('collapsed', allCollapsed);
  }
  updateCollapseButton();
}

function renderTypeChips() {
  const types = [...availableTypes].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a);
    const ib = TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  typeChipsEl.innerHTML = '';
  for (const t of types) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'type-chip' + (typeFilter.has(t) ? ' active' : '');
    chip.dataset.type = t;
    chip.setAttribute('aria-pressed', typeFilter.has(t) ? 'true' : 'false');
    chip.textContent = t;
    typeChipsEl.appendChild(chip);
  }
}

// --- window index + upcoming strip ------------------------------------------

function rebuildIndex() {
  movieCatalog.clear();
  firstDateByMovie.clear();
  availableTypes.clear();
  // Ascending date order → first occurrence is the earliest date in the window.
  for (const date of [...windowCache.keys()].sort()) {
    for (const m of windowCache.get(date).data.Movies || []) {
      const info = { id: m.Id, name: m.Name, poster: m.PosterUrl };
      if (!movieCatalog.has(m.Id)) movieCatalog.set(m.Id, info);
      if (!firstDateByMovie.has(m.Id)) firstDateByMovie.set(m.Id, { ...info, firstDate: date });
      for (const cm of m.CinemaModels || []) {
        for (const s of cm.Sessions || []) {
          if (s.ScreenTypeName) availableTypes.add(s.ScreenTypeName);
        }
      }
    }
  }
}

function renderUpcoming() {
  if (!currentDate) {
    upcomingEl.hidden = true;
    return;
  }
  // Movies whose first session in the window is AFTER the selected day
  // (i.e. not yet showing). Respects the movie filter when one is active.
  let entries = [...firstDateByMovie.values()].filter((x) => x.firstDate > currentDate);
  if (movieFilter.size) entries = entries.filter((x) => movieFilter.has(x.id));
  entries.sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.name.localeCompare(b.name));

  upcomingStripEl.innerHTML = '';
  if (!entries.length) {
    if (windowLoading) {
      upcomingEl.hidden = false;
      upcomingStripEl.innerHTML = '<div class="upcoming-loading">Checking the rest of the week…</div>';
    } else {
      upcomingEl.hidden = true;
    }
    return;
  }

  for (const e of entries) {
    const card = document.createElement('button');
    card.className = 'up-card';
    card.type = 'button';
    card.dataset.date = e.firstDate;
    const img = document.createElement('img');
    img.className = 'up-poster';
    img.src = e.poster;
    img.alt = `${e.name} poster`;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className = 'up-poster broken';
      ph.textContent = 'No image';
      img.replaceWith(ph);
    });
    const nm = document.createElement('div');
    nm.className = 'up-name';
    nm.textContent = e.name;
    const dt = document.createElement('div');
    dt.className = 'up-date';
    dt.textContent = formatShortDate(e.firstDate);
    card.append(img, nm, dt);
    upcomingStripEl.appendChild(card);
  }
  upcomingEl.hidden = false;
}

// --- data flow --------------------------------------------------------------

function sessionsQuery(date) {
  const p = new URLSearchParams();
  for (const id of selectedCinemaIds) p.append('cinemaIds', String(id));
  if (date) p.set('date', date);
  return p.toString();
}

async function fetchDate(date) {
  const res = await fetch('/api/sessions?' + sessionsQuery(date));
  const source = res.headers.get('X-Data-Source');
  const today = res.headers.get('X-Today');
  const json = await res.json();
  if (!json.Success) throw new Error(json.Error || 'Endpoint returned an error');
  const data = json.Data;
  if (todayStr === null) todayStr = today || data.SelectedDate;
  windowCache.set(data.SelectedDate, { data, source });
  return data.SelectedDate;
}

function showError(message) {
  statusEl.hidden = false;
  gridEl.hidden = true;
  statusEl.className = 'status error';
  statusEl.textContent = `Couldn't load sessions: ${message}`;
  gridEl.classList.remove('updating');
}

function renderGrid(data) {
  const allMovies = data.Movies || [];
  const byMovie = movieFilter.size ? allMovies.filter((m) => movieFilter.has(m.Id)) : allMovies;
  const movies = byMovie.filter(movieMatchesType);

  gridEl.innerHTML = '';
  gridEl.classList.remove('updating');

  if (!movies.length) {
    gridEl.hidden = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    const dateLong = formatDateLong(currentDate);
    if (!allMovies.length) {
      statusEl.textContent =
        currentDate === todayStr
          ? 'No more sessions today at the selected cinemas.'
          : `No sessions on ${dateLong} at the selected cinemas.`;
    } else if (movieFilter.size && !byMovie.length) {
      statusEl.textContent = `None of your selected movies are showing on ${dateLong}.`;
    } else {
      statusEl.textContent = `No sessions match your filters on ${dateLong}.`;
    }
    return;
  }

  for (const movie of movies) gridEl.appendChild(renderMovie(movie));
  statusEl.hidden = true;
  gridEl.hidden = false;
}

// Render everything for the currently selected (cached) date.
function render() {
  const entry = windowCache.get(currentDate);
  if (!entry) return;
  renderContext(entry.data, entry.source);
  renderDateBar(currentDate);
  renderTypeChips();
  renderUpcoming();
  renderGrid(entry.data);
}

async function selectDate(date) {
  if (!date || date === currentDate) return;
  currentDate = date;
  renderDateBar(currentDate); // immediate highlight
  renderUpcoming();
  if (windowCache.has(date)) {
    render();
    return;
  }
  gridEl.classList.add('updating');
  try {
    await fetchDate(date);
    render();
  } catch (err) {
    showError(err.message);
  }
}

// Fetch the selected day, render it, then background-fill the rest of the window.
async function startWindow() {
  windowCache.clear();
  movieCatalog.clear();
  firstDateByMovie.clear();
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.textContent = 'Loading sessions…';
  gridEl.hidden = true;

  try {
    currentDate = await fetchDate(currentDate); // null on first load → today
  } catch (err) {
    showError(err.message);
    return;
  }

  windowDates = Array.from({ length: MAX_DAYS }, (_, i) => addDays(todayStr, i));
  rebuildIndex();
  render();
  prefetchRest();
}

async function prefetchRest() {
  windowLoading = true;
  renderUpcoming(); // show the "checking…" hint while empty
  const todo = windowDates.filter((d) => !windowCache.has(d));
  for (let i = 0; i < todo.length; i += PREFETCH_BATCH) {
    const batch = todo.slice(i, i + PREFETCH_BATCH);
    await Promise.all(batch.map((d) => fetchDate(d).catch(() => null)));
    rebuildIndex();
    updateMovieButton(); // resolve filter names once their movies are known
    renderTypeChips();
    renderUpcoming();
    if (!movieModalEl.hidden) buildMovieList(movieSearchEl.value);
  }
  windowLoading = false;
  renderUpcoming();
}

// --- events -----------------------------------------------------------------

dayStripEl.addEventListener('click', (e) => {
  const pill = e.target.closest('.day-pill');
  if (pill) selectDate(pill.dataset.date);
});

upcomingStripEl.addEventListener('click', (e) => {
  const card = e.target.closest('.up-card');
  if (card) selectDate(card.dataset.date);
});

collapseBtnEl.addEventListener('click', toggleCollapseAll);

typeChipsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.type-chip');
  if (!chip) return;
  const t = chip.dataset.type;
  if (typeFilter.has(t)) typeFilter.delete(t);
  else typeFilter.add(t);
  render();
});

cinemaBtnEl.addEventListener('click', openCinemaModal);
cinemaApplyEl.addEventListener('click', applyCinemaSelection);
cinemaSearchEl.addEventListener('input', () => buildCinemaList(cinemaSearchEl.value));
cinemaListEl.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  const id = Number(cb.value);
  if (cb.checked) cinemaWorking.add(id);
  else cinemaWorking.delete(id);
  updateCinemaFooter();
});
cinemaModalEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeCinemaModal();
});

movieBtnEl.addEventListener('click', openMovieModal);
movieApplyEl.addEventListener('click', applyMovieFilter);
movieClearEl.addEventListener('click', clearMovieFilter);
movieSearchEl.addEventListener('input', () => buildMovieList(movieSearchEl.value));
movieListEl.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  const id = Number(cb.value);
  if (cb.checked) movieWorking.add(id);
  else movieWorking.delete(id);
  updateMovieFooter();
});
movieModalEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeMovieModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!cinemaModalEl.hidden) closeCinemaModal();
  if (!movieModalEl.hidden) closeMovieModal();
});

// --- startup ----------------------------------------------------------------

async function init() {
  try {
    cinemas = await (await fetch('/cinemas.json')).json();
  } catch (_) {
    cinemas = []; // picker empty; proxy defaults still apply
  }
  loadSelectedCinemaIds();
  loadMovieFilter();
  updateCinemaButton();
  updateMovieButton();
  updateCollapseButton();
  startWindow();
}

init();
