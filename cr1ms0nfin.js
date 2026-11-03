/* cr1ms0nfin.js: optional extras for the cr1ms0nfin Jellyfin theme.
 *
 * Paste into the JavaScript Injector plugin (Dashboard → JS Injector → Add
 * Script). theme.css must already be in Dashboard → General → Custom CSS;
 * this file only adds what CSS can't do:
 *
 *   1. dashboard: Jellyfin leaves Custom CSS off admin pages, so the theme
 *      is fetched once and kept in the page
 *   2. hero: a full-width banner at the top of Home showing what you were
 *      watching (or, if nothing, an unwatched film picked once per session)
 *
 * Uses only Jellyfin's own window.ApiClient (your logged-in session) and
 * talks to your own server. No third-party code, no tracking.
 */
(() => {
    'use strict';

    const CONFIG = {
        dashboard: true,
        hero: true,
        // what the hero falls back to when nothing is in progress
        heroFallbackTypes: 'Movie,Series',
    };

    const PREFIX = 'c0';
    const log = (...a) => console.debug('[cr1ms0nfin]', ...a);

    const waitFor = (test, timeout = 20000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const v = test();
            if (v) return resolve(v);
            if (Date.now() - start > timeout) return reject(new Error('timed out'));
            setTimeout(tick, 150);
        };
        tick();
    });

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };

    /* ------------------------------------------------------------------ *
     * 1. keep the theme on dashboard pages
     * ------------------------------------------------------------------ */
    async function keepThemeOnDashboard(api) {
        if (document.getElementById(`${PREFIX}-keep`)) return;
        try {
            const res = await fetch(api.getUrl('Branding/Css.css'), { cache: 'no-cache' });
            const css = await res.text();
            if (!css.trim()) return;
            const style = el('style');
            style.id = `${PREFIX}-keep`;
            style.textContent = css;
            // only needed where Jellyfin's own copy is missing; toggled below
            document.head.appendChild(style);
            const sync = () => {
                style.disabled = !location.hash.includes('/dashboard') &&
                    !document.querySelector('.dashboardDocument, #dashboardPage');
            };
            sync();
            window.addEventListener('hashchange', sync);
            new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        } catch (e) {
            log('dashboard css failed', e);
        }
    }

    /* ------------------------------------------------------------------ *
     * 2. home hero
     * ------------------------------------------------------------------ */
    const fmtRuntime = ticks => {
        const mins = Math.round(ticks / 600000000);
        if (!mins) return '';
        const h = Math.floor(mins / 60), m = mins % 60;
        return h ? `${h}h ${m}m` : `${m}m`;
    };

    async function pickHeroItem(api) {
        const userId = api.getCurrentUserId();
        const fields = 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating';
        const common = { userId, Limit: 1, Fields: fields, EnableImageTypes: 'Backdrop,Logo,Primary', ImageTypeLimit: 1 };

        const resume = await api.getJSON(api.getUrl('UserItems/Resume', { ...common, MediaTypes: 'Video' }));
        if (resume.Items && resume.Items.length) return { item: resume.Items[0], resume: true };

        // same pick for the whole session, so Home doesn't reshuffle on every visit
        const saved = sessionStorage.getItem(`${PREFIX}-hero`);
        if (saved) {
            try {
                const item = await api.getJSON(api.getUrl(`Users/${userId}/Items/${saved}`, { Fields: fields }));
                if (item && !(item.UserData && item.UserData.Played)) return { item, resume: false };
            } catch { /* deleted since; pick again */ }
        }
        const pick = await api.getJSON(api.getUrl('Items', {
            ...common,
            Recursive: true,
            IncludeItemTypes: CONFIG.heroFallbackTypes,
            Filters: 'IsUnplayed',
            HasBackdrop: true,
            SortBy: 'Random',
        }));
        if (!pick.Items || !pick.Items.length) return null;
        sessionStorage.setItem(`${PREFIX}-hero`, pick.Items[0].Id);
        return { item: pick.Items[0], resume: false };
    }

    function imageUrl(api, item, type) {
        // episodes borrow the series backdrop and logo
        if (type === 'Backdrop') {
            if (item.BackdropImageTags && item.BackdropImageTags.length)
                return api.getUrl(`Items/${item.Id}/Images/Backdrop/0`, { maxWidth: 1920, tag: item.BackdropImageTags[0] });
            if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length)
                return api.getUrl(`Items/${item.ParentBackdropItemId}/Images/Backdrop/0`, { maxWidth: 1920, tag: item.ParentBackdropImageTags[0] });
        }
        if (type === 'Logo') {
            if (item.ImageTags && item.ImageTags.Logo)
                return api.getUrl(`Items/${item.Id}/Images/Logo`, { maxWidth: 600, tag: item.ImageTags.Logo });
            if (item.ParentLogoItemId && item.ParentLogoImageTag)
                return api.getUrl(`Items/${item.ParentLogoItemId}/Images/Logo`, { maxWidth: 600, tag: item.ParentLogoImageTag });
        }
        return null;
    }

    // Some logos are black, or sit in a big empty canvas: crop to the visible
    // pixels and flag dark ones so CSS can turn them white. Falls back to the
    // plain URL if the canvas can't be read.
    function prepareLogo(url) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                try {
                    const w = img.naturalWidth, h = img.naturalHeight;
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const px = ctx.getImageData(0, 0, w, h).data;
                    let x0 = w, y0 = h, x1 = -1, y1 = -1, lum = 0, n = 0;
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const i = (y * w + x) * 4;
                            if (px[i + 3] < 24) continue;
                            if (x < x0) x0 = x; if (x > x1) x1 = x;
                            if (y < y0) y0 = y; if (y > y1) y1 = y;
                            lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
                            n++;
                        }
                    }
                    if (!n) return resolve({ src: url, dark: false });
                    const out = document.createElement('canvas');
                    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
                    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
                    resolve({ src: out.toDataURL('image/png'), dark: lum / n < 70 });
                } catch {
                    resolve({ src: url, dark: false });
                }
            };
            img.onerror = () => resolve({ src: url, dark: false });
            img.src = url;
        });
    }

    function openAndPlay(id) {
        location.hash = `#/details?id=${id}`;
        // the details page renders its own Play/Resume button; press it once it's there
        waitFor(() => {
            const page = document.querySelector('.itemDetailPage:not(.hide)');
            const btn = page && page.querySelector('.mainDetailButtons .btnPlay:not(.hide)');
            return btn && location.hash.includes(id) ? btn : null;
        }, 10000).then(btn => btn.click()).catch(() => {});
    }

    function isNov14(d = new Date()) {
        return location.href.includes('bday') || (d.getMonth() === 10 && d.getDate() === 14);
    }

    function buildHero(api, { item, resume }) {
        const hero = el('section', `${PREFIX}-hero`);
        hero.setAttribute('aria-label', resume ? 'Continue watching' : 'Featured');

        const backdrop = imageUrl(api, item, 'Backdrop');
        if (!backdrop) hero.classList.add(`${PREFIX}-hero-noart`);
        if (backdrop) {
            const bg = el('div', `${PREFIX}-hero-bg`);
            bg.style.backgroundImage = `url("${backdrop}")`;
            hero.appendChild(bg);
        }

        const body = el('div', `${PREFIX}-hero-body`);
        body.appendChild(el('div', `${PREFIX}-hero-kicker`, isNov14() ? 'happy birthday zain' : resume ? 'continue watching' : 'unwatched'));

        const logo = imageUrl(api, item, 'Logo');
        const title = item.Type === 'Episode' ? item.SeriesName : item.Name;
        if (logo) {
            const img = el('img', `${PREFIX}-hero-logo`);
            img.alt = title;
            body.appendChild(img);
            prepareLogo(logo).then(({ src, dark }) => {
                img.src = src;
                if (dark) img.classList.add(`${PREFIX}-hero-logo-dark`);
            });
        } else {
            body.appendChild(el('h2', `${PREFIX}-hero-title`, title));
        }

        const meta = [];
        if (item.Type === 'Episode') {
            meta.push(`S${String(item.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(item.IndexNumber ?? 0).padStart(2, '0')}`);
            meta.push(item.Name);
        }
        if (item.ProductionYear) meta.push(String(item.ProductionYear));
        if (item.RunTimeTicks && fmtRuntime(item.RunTimeTicks)) meta.push(fmtRuntime(item.RunTimeTicks));
        if (item.OfficialRating) meta.push(item.OfficialRating);
        if (item.CommunityRating) meta.push(`★ ${item.CommunityRating.toFixed(1)}`);
        const metaRow = el('div', `${PREFIX}-hero-meta`);
        meta.forEach(m => metaRow.appendChild(el('span', null, m)));
        body.appendChild(metaRow);

        const pct = item.UserData && item.UserData.PlayedPercentage;
        if (resume && pct) {
            const bar = el('div', `${PREFIX}-hero-progress`);
            const fill = el('div');
            fill.style.width = `${Math.min(100, pct)}%`;
            bar.appendChild(fill);
            body.appendChild(bar);
            const left = item.RunTimeTicks && item.UserData.PlaybackPositionTicks
                ? fmtRuntime(item.RunTimeTicks - item.UserData.PlaybackPositionTicks) : '';
            body.appendChild(el('div', `${PREFIX}-hero-left`, left ? `${left} left` : `${Math.round(pct)}%`));
        }

        if (item.Overview) body.appendChild(el('p', `${PREFIX}-hero-overview`, item.Overview));

        const actions = el('div', `${PREFIX}-hero-actions`);
        const playId = item.Id;
        const play = el('button', `${PREFIX}-hero-play`, resume ? 'Resume' : 'Play');
        play.type = 'button';
        play.addEventListener('click', () => openAndPlay(playId));
        const info = el('button', `${PREFIX}-hero-info`, 'Details');
        info.type = 'button';
        info.addEventListener('click', () => { location.hash = `#/details?id=${item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id}`; });
        actions.append(play, info);
        body.appendChild(actions);

        hero.appendChild(body);
        return hero;
    }

    let heroBusy = false;
    async function ensureHero(api) {
        if (heroBusy) return;
        const tab = document.querySelector('#indexPage:not(.hide) #homeTab');
        const sections = tab && tab.querySelector('.homeSectionsContainer');
        if (!sections || tab.querySelector(`.${PREFIX}-hero`)) return;
        heroBusy = true;
        try {
            const pick = await pickHeroItem(api);
            if (!pick || tab.querySelector(`.${PREFIX}-hero`)) return;
            // before the sections container, not in it: Jellyfin re-renders the
            // sections on refresh and would throw the hero away
            sections.parentNode.insertBefore(buildHero(api, pick), sections);
        } catch (e) {
            log('hero failed', e);
        } finally {
            heroBusy = false;
        }
    }

    /* ------------------------------------------------------------------ */
    waitFor(() => window.ApiClient && window.ApiClient.getCurrentUserId && window.ApiClient.getCurrentUserId())
        .then(() => {
            const api = window.ApiClient;
            if (CONFIG.dashboard) keepThemeOnDashboard(api);
            if (CONFIG.hero) {
                let queued = false;
                const check = () => {
                    if (queued) return;
                    queued = true;
                    requestAnimationFrame(() => { queued = false; ensureHero(api); });
                };
                new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
                window.addEventListener('hashchange', check);
                check();
            }
        })
        .catch(() => log('no ApiClient; not logged in yet?'));
})();
