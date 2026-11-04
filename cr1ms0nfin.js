/* cr1ms0nfin.js: optional extras for the cr1ms0nfin Jellyfin theme.
 *
 * Paste into the JavaScript Injector plugin (Dashboard → JS Injector → Add
 * Script). theme.css must already be in Dashboard → General → Custom CSS;
 * this file only adds what CSS can't do:
 *
 *   1. dashboard: Jellyfin leaves Custom CSS off admin pages, so the theme
 *      is fetched once and kept in the page
 *   2. hero: a full-width banner at the top of Home showing what you were
 *      watching, else the next episode of a show you're partway through,
 *      else an unwatched film or show picked once per session
 *   3. player: a one-line status bar while paused, a volume number when you
 *      change it, and the theme's subtitle look while yours is the default
 *   4. episode lists: S01E03 in front of each episode title
 *
 * Uses only Jellyfin's own window.ApiClient (your logged-in session) and
 * talks to your own server. No third-party code, no tracking.
 */
(() => {
    'use strict';

    const CONFIG = {
        dashboard: true,
        hero: true,
        // paused status line, volume number, subtitle look
        player: true,
        // S01E03 in front of episode titles in lists
        episodeNumbers: true,
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

        // then the next episode of a show you're partway through
        // (up to three, so the desktop hero can cycle through them)
        const next = await api.getJSON(api.getUrl('Shows/NextUp', { ...common, Limit: 3, DisableFirstEpisode: true, EnableResumable: false }));
        if (next.Items && next.Items.length)
            return { item: next.Items[0], resume: false, next: true, all: next.Items };

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

    function buildHero(api, { item, resume, next }, steps) {
        const hero = el('section', `${PREFIX}-hero`);
        hero.setAttribute('aria-label', resume ? 'Continue watching' : next ? 'Next up' : 'Featured');

        const backdrop = imageUrl(api, item, 'Backdrop');
        if (!backdrop) hero.classList.add(`${PREFIX}-hero-noart`);
        if (backdrop) {
            const bg = el('div', `${PREFIX}-hero-bg`);
            bg.style.backgroundImage = `url("${backdrop}")`;
            hero.appendChild(bg);
        }

        const body = el('div', `${PREFIX}-hero-body`);
        body.appendChild(el('div', `${PREFIX}-hero-kicker`, resume ? 'continue watching' : next ? 'next up' : 'unwatched'));

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
        // part-watched: time left in the meta line instead of the runtime
        const pct = item.UserData && item.UserData.PlayedPercentage;
        const left = resume && item.RunTimeTicks && item.UserData && item.UserData.PlaybackPositionTicks
            ? fmtRuntime(item.RunTimeTicks - item.UserData.PlaybackPositionTicks) : '';
        if (item.ProductionYear) meta.push(String(item.ProductionYear));
        if (left) meta.push(`${left} left`);
        else if (item.RunTimeTicks && fmtRuntime(item.RunTimeTicks)) meta.push(fmtRuntime(item.RunTimeTicks));
        if (item.OfficialRating) meta.push(item.OfficialRating);
        if (item.CommunityRating) meta.push(`★ ${item.CommunityRating.toFixed(1)}`);
        const metaRow = el('div', `${PREFIX}-hero-meta`);
        meta.forEach(m => metaRow.appendChild(el('span', null, m)));
        body.appendChild(metaRow);

        if (resume && pct) {
            const bar = el('div', `${PREFIX}-hero-progress`);
            const fill = el('div');
            fill.style.width = `${Math.min(100, pct)}%`;
            bar.appendChild(fill);
            body.appendChild(bar);
            // under a minute left rounds to nothing in the meta line; say how far in
            if (!left) body.appendChild(el('div', `${PREFIX}-hero-left`, `${Math.round(pct)}%`));
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

        // one square per item when the hero cycles; click to jump
        if (steps && steps.total > 1) {
            const row = el('div', `${PREFIX}-hero-steps`);
            for (let i = 0; i < steps.total; i++) {
                const b = el('button');
                b.type = 'button';
                b.setAttribute('aria-label', `Show ${i + 1} of ${steps.total}`);
                if (i === steps.index) b.setAttribute('aria-current', 'true');
                b.addEventListener('click', () => steps.go(i));
                row.appendChild(b);
            }
            body.appendChild(row);
        }

        hero.appendChild(body);
        return hero;
    }

    const layoutIs = name => document.documentElement.classList.contains(`layout-${name}`);
    const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Shows the hero in its stack. With several next-up items on the desktop
    // layout it cycles through them, crossfading, and holds still while the
    // pointer or focus is on it.
    function startHero(api, stack, pick) {
        // only cycle through items with a backdrop: a bare one is shorter and
        // would make the rows below jump
        const all = pick.all || [pick.item];
        const items = [all[0], ...all.slice(1).filter(i => imageUrl(api, i, 'Backdrop'))]
            .map(item => ({ ...pick, item }));
        const cycles = items.length > 1 && !layoutIs('tv') && !layoutIs('mobile');
        let index = 0, timer = null;

        const show = (i, fade) => {
            index = (i + items.length) % items.length;
            const steps = cycles ? { index, total: items.length, go: j => { show(j, true); schedule(); } } : null;
            const hero = buildHero(api, items[index], steps);
            const old = [...stack.children];
            if (fade && old.length) {
                hero.classList.add(`${PREFIX}-hero-fadein`);
                old.forEach(o => o.classList.add(`${PREFIX}-hero-fadeout`));
                hero.addEventListener('animationend', () => old.forEach(o => o.remove()), { once: true });
                // reduced motion turns the fade into 1ms; drop the old one anyway
                setTimeout(() => old.forEach(o => o.remove()), 1000);
            } else {
                old.forEach(o => o.remove());
            }
            stack.appendChild(hero);
        };
        const held = () => stack.matches(':hover') || stack.contains(document.activeElement) || document.hidden;
        const schedule = () => {
            clearTimeout(timer);
            if (!cycles || reducedMotion()) return;
            timer = setTimeout(() => {
                if (!stack.isConnected) return;
                if (!held()) show(index + 1, true);
                schedule();
            }, 9000);
        };
        show(0, false);
        schedule();
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
            const stack = el('div', `${PREFIX}-hero-stack`);
            sections.parentNode.insertBefore(stack, sections);
            startHero(api, stack, pick);
        } catch (e) {
            log('hero failed', e);
        } finally {
            heroBusy = false;
        }
    }

    // TV layout: Jellyfin's d-pad navigation picks the target that lines up
    // best horizontally, so it skips the left-aligned hero buttons and goes
    // header <-> first row. Route those two moves through the hero instead.
    function heroTvNav(e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        if (!document.documentElement.classList.contains('layout-tv')) return;
        const play = document.querySelector(`#indexPage:not(.hide) .${PREFIX}-hero-play`);
        const a = document.activeElement;
        if (!play || !a || a.closest(`.${PREFIX}-hero`)) return;
        const firstRow = [...document.querySelectorAll('#indexPage:not(.hide) .homeSectionsContainer > .verticalSection')]
            .find(s => s.offsetHeight > 0);
        const fromHeader = e.key === 'ArrowDown' && a.closest('.skinHeader');
        const fromFirstRow = e.key === 'ArrowUp' && firstRow && firstRow.contains(a);
        if (!fromHeader && !fromFirstRow) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        play.focus();
    }

    /* ------------------------------------------------------------------ *
     * 3. player: paused status line, volume number
     * ------------------------------------------------------------------ */
    const fmtLeft = secs => {
        secs = Math.max(0, Math.round(secs));
        if (secs < 60) return `${secs}s left`;
        const m = Math.round(secs / 60), h = Math.floor(m / 60);
        return h ? `${h}h ${String(m % 60).padStart(2, '0')}m left` : `${m}m left`;
    };

    // Once the controls hide while paused, a single mono line at the bottom
    // says what's on: "paused_ · Pioneer One · S01E03 Alone in the Night · 8m left"
    function pauseBar(api) {
        const bar = el('div', `${PREFIX}-pausebar`);
        bar.setAttribute('aria-hidden', 'true');
        const parts = ['state', 'title', 'ep', 'left'].map(k => el('span', `${PREFIX}-pausebar-${k}`));
        parts[0].textContent = 'paused';
        bar.append(...parts);
        document.body.appendChild(bar);

        let src = null;
        const describe = async () => {
            try {
                const sessions = await api.getJSON(api.getUrl('Sessions', {
                    ControllableByUserId: api.getCurrentUserId(), DeviceId: api.deviceId(),
                }));
                const s = sessions.find(x => x.NowPlayingItem);
                const it = s && s.NowPlayingItem;
                if (!it) return;
                const ep = it.Type === 'Episode';
                parts[1].textContent = ep ? it.SeriesName : it.Name;
                parts[2].textContent = ep
                    ? `S${String(it.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(it.IndexNumber ?? 0).padStart(2, '0')} ${it.Name}`
                    : (it.ProductionYear ? String(it.ProductionYear) : '');
                parts[2].hidden = !parts[2].textContent;
            } catch (e) {
                log('pause bar', e);
            }
        };
        // only polls while a video is open: media events start it, and it
        // stops itself once the player page is gone
        let timer = null;
        const tick = () => {
            const page = document.querySelector('#videoOsdPage:not(.hide)');
            const v = page && document.querySelector('video');
            const osd = page && page.querySelector('.videoOsdBottom');
            if (!v) {
                bar.classList.remove(`${PREFIX}-pausebar-on`);
                clearInterval(timer);
                timer = null;
                return;
            }
            if (v.currentSrc !== src) {
                src = v.currentSrc;
                parts[1].textContent = parts[2].textContent = '';
                describe();
            }
            const on = !!(osd && v.paused && !v.ended && parts[1].textContent &&
                osd.classList.contains('videoOsdBottom-hidden'));
            if (on && v.duration) parts[3].textContent = fmtLeft(v.duration - v.currentTime);
            bar.classList.toggle(`${PREFIX}-pausebar-on`, on);
        };
        const start = e => {
            if (timer || !(e.target instanceof HTMLVideoElement)) return;
            timer = setInterval(tick, 250);
        };
        ['play', 'pause', 'loadstart'].forEach(t => document.addEventListener(t, start, true));
    }

    // Volume as a number. Jellyfin only loads its own volume pop-up on touch
    // devices and TVs, so in a desktop browser the arrow keys change the
    // volume with nothing on screen: draw a small one. Where Jellyfin's
    // pop-up does exist, put the number in that instead.
    function volumeNumber() {
        const box = el('div', `${PREFIX}-vol`);
        box.setAttribute('aria-hidden', 'true');
        const num = el('div', `${PREFIX}-vol-num`);
        const bar = el('div', `${PREFIX}-vol-bar`);
        const fill = el('div');
        bar.appendChild(fill);
        box.append(num, bar);
        document.body.appendChild(box);

        // Jellyfin sets the volume itself when playback starts; don't flash then
        const started = new WeakMap();
        document.addEventListener('loadstart', e => started.set(e.target, Date.now()), true);
        let hide = null;
        const showBox = v => {
            // Jellyfin's pop-up (when it has one) appears a frame later
            if (document.querySelector('.volumeOsd:not(.hide)')) return;
            // Jellyfin's level is the cube root of the element's volume
            const level = Math.min(100, Math.round(100 * Math.cbrt(v.volume)));
            num.textContent = v.muted ? 'muted' : `vol ${level}%`;
            fill.style.width = `${v.muted ? 0 : level}%`;
            box.classList.add(`${PREFIX}-vol-on`);
            clearTimeout(hide);
            hide = setTimeout(() => box.classList.remove(`${PREFIX}-vol-on`), 1500);
        };
        document.addEventListener('volumechange', e => {
            const v = e.target;
            if (!(v instanceof HTMLMediaElement)) return;
            if (Date.now() - (started.get(v) || 0) < 1500) return;
            requestAnimationFrame(() => requestAnimationFrame(() => showBox(v)));
        }, true);

        const attach = osd => {
            osd.dataset.c0 = '1';
            const inner = osd.querySelector('.iconOsdProgressInner');
            const icon = osd.querySelector('.iconOsdIcon');
            const label = el('div', `${PREFIX}-volnum`);
            osd.appendChild(label);
            const sync = () => {
                label.textContent = icon && icon.classList.contains('volume_off')
                    ? 'muted' : `${Math.round(parseFloat(inner && inner.style.width) || 0)}%`;
            };
            new MutationObserver(sync).observe(osd, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
            sync();
        };
        new MutationObserver(() => {
            const osd = document.querySelector('.volumeOsd:not([data-c0])');
            if (osd) attach(osd);
        }).observe(document.body, { childList: true });
    }

    // Subtitles: the theme's look (Plex Sans on a black box) applies only
    // while the user's Subtitle Appearance settings are still Jellyfin's
    // defaults, so anyone who picked their own font or background keeps it.
    function subtitleDefaults() {
        const check = () => {
            const st = document.getElementById('htmlvideoplayer-cuestyle');
            const css = st ? st.textContent : '';
            const stock = !st || (/font-family:-apple-system/.test(css) && /background-color:transparent/.test(css));
            document.documentElement.classList.toggle(`${PREFIX}-subs`, stock);
        };
        new MutationObserver(check).observe(document.head, { childList: true, subtree: true, characterData: true });
        check();
    }

    /* ------------------------------------------------------------------ *
     * 4. episode rows: S01E03 in front of the title
     * ------------------------------------------------------------------ */
    async function episodeNumbers(api) {
        const rows = [...document.querySelectorAll('.listItem[data-type="Episode"]:not([data-c0-ep])')];
        if (!rows.length) return;
        rows.forEach(r => { r.dataset.c0Ep = '1'; });
        try {
            const res = await api.getJSON(api.getUrl('Items', {
                userId: api.getCurrentUserId(), Ids: rows.map(r => r.dataset.id).slice(0, 200).join(','),
            }));
            const byId = new Map((res.Items || []).map(i => [i.Id, i]));
            for (const r of rows) {
                const it = byId.get(r.dataset.id);
                const bdi = r.querySelector('.listItemBody .listItemBodyText bdi');
                if (!it || !bdi || it.IndexNumber == null) continue;
                // "3. Alone in the Night" -> "S01E03 Alone in the Night"
                bdi.textContent = bdi.textContent.replace(/^\s*\d+(-\d+)?\.\s*/, '');
                bdi.prepend(el('span', `${PREFIX}-epnum`,
                    `S${String(it.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(it.IndexNumber).padStart(2, '0')}`));
            }
        } catch (e) {
            log('episode numbers', e);
        }
    }

    /* ------------------------------------------------------------------ */
    waitFor(() => window.ApiClient && window.ApiClient.getCurrentUserId && window.ApiClient.getCurrentUserId())
        .then(() => {
            const api = window.ApiClient;
            if (CONFIG.dashboard) keepThemeOnDashboard(api);
            if (CONFIG.player) {
                pauseBar(api);
                volumeNumber();
                subtitleDefaults();
            }
            if (CONFIG.episodeNumbers) {
                let queued = false;
                new MutationObserver(() => {
                    if (queued) return;
                    queued = true;
                    requestAnimationFrame(() => { queued = false; episodeNumbers(api); });
                }).observe(document.body, { childList: true, subtree: true });
            }
            if (CONFIG.hero) {
                let queued = false;
                const check = () => {
                    if (queued) return;
                    queued = true;
                    requestAnimationFrame(() => { queued = false; ensureHero(api); });
                };
                new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
                window.addEventListener('hashchange', check);
                document.addEventListener('keydown', heroTvNav, true);
                check();
            }
        })
        .catch(() => log('no ApiClient; not logged in yet?'));
})();
