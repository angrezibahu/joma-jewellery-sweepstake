// ============================================
// Joma Jewellery World Cup Sweepstake
// Curated by Megg
// ============================================

let state = loadState();
if (!state.overrides) state.overrides = {};   // migrate older saved state
const isAdmin = new URLSearchParams(window.location.search).get("admin") === "true";

const TOTAL_SPOTS = 48;

// ---- Init ----
document.addEventListener("DOMContentLoaded", async () => {
    setupTabs();
    renderSpotsBadge();
    updateDrawStatus();
    updateBankDetails();

    await loadLiveData();          // pull committed schedule + auto-updated results
    renderGroups();
    renderBracket();
    renderFixtures();
    setupAdmin();
    setupTeamClicks();

    // Fixtures is the default tab now the draw's done — open it anchored to today.
    if (document.querySelector(".tab.active")?.dataset.tab === "fixtures") {
        // Wait for layout so scrollIntoView lands on the right offset.
        requestAnimationFrame(() => scrollFixturesToToday(false));
    }
});

// Delegated click: anywhere a team name is rendered with [data-team-click],
// tapping it replays the right animation for that team's current state.
function setupTeamClicks() {
    const activate = (el) => {
        if (document.querySelector(".anim-overlay")) return;  // one at a time
        // On the Tournament Tracker, show the team's full journey (matches +
        // current standing). Elsewhere (e.g. fixtures) keep the quick animation.
        if (el.closest("#bracket")) {
            showTeamDetails(el.dataset.teamClick);
        } else {
            playTeamStatus(el.dataset.teamClick);
        }
    };
    document.addEventListener("click", (e) => {
        const el = e.target.closest("[data-team-click]");
        if (!el) return;
        e.preventDefault();
        activate(el);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const el = e.target.closest("[data-team-click]");
        if (!el) return;
        e.preventDefault();
        activate(el);
    });
}

function playTeamStatus(name) {
    const team = findTeam(name);
    if (!team) return;
    if (isEliminated(name)) {
        playEliminationAnimation(team);
        return;
    }
    const stage = getStage(name);
    playAdvanceAnimation(team, "groups", stage, { review: true });
}

// Every match a team is involved in, in schedule order, with the result worked
// out from their point of view. fixtureSide resolves knockout placeholders, so
// this picks up games they reached beyond the group stage too.
function teamMatches(name) {
    const out = [];
    for (const m of SCHEDULE) {
        const home = fixtureSide(m, "home");
        const away = fixtureSide(m, "away");
        if (home.name !== name && away.name !== name) continue;
        const isHome = home.name === name;
        const opp = isHome ? away : home;
        out.push({ m, isHome, oppName: opp.name });
    }
    return out.sort((a, b) => a.m.match - b.m.match);
}

// Tournament Tracker: a readable summary of where a team has got to —
// who they've played, the scores, and where they stand now.
function showTeamDetails(name) {
    const team = findTeam(name);
    if (!team) return;
    const owner = state.assignments[name];
    const eliminated = isEliminated(name);
    const stage = getStage(name);

    const statusText = eliminated
        ? "Eliminated"
        : stage === "winner" ? "Champions! 🏆" : `Still in it — ${getStageName(stage)}`;
    const statusClass = eliminated ? "eliminated" : "alive";

    const matches = teamMatches(name);
    let rows = "";
    for (const { m, isHome, oppName } of matches) {
        const rec = RESULTS[String(m.match)] || {};
        const finished = rec.status === "FINISHED" && rec.homeScore != null;
        const d = new Date(m.ukDate + "T12:00:00Z");
        const dateLabel = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        const oppLabel = oppName
            ? `${teamFlag(oppName)} ${escapeHtml(oppName)}`
            : "TBC";
        const tag = m.stage === "group"
            ? `Group ${escapeHtml(m.group)}`
            : (STAGE_LABEL_LONG[m.stage] || escapeHtml(m.stage));

        let resultHtml, outcomeClass = "";
        if (finished) {
            const teamScore = Number(isHome ? rec.homeScore : rec.awayScore);
            const oppScore = Number(isHome ? rec.awayScore : rec.homeScore);
            outcomeClass = teamScore > oppScore ? "win" : teamScore < oppScore ? "loss" : "draw";
            const tagWord = outcomeClass === "win" ? "Won" : outcomeClass === "loss" ? "Lost" : "Drew";
            resultHtml = `<span class="td-score">${teamScore}–${oppScore}</span><span class="td-outcome ${outcomeClass}">${tagWord}</span>`;
        } else {
            resultHtml = `<span class="td-ko">${escapeHtml(m.ukTime)}</span>`;
        }

        rows += `
            <div class="td-match ${outcomeClass || "upcoming"}">
                <div class="td-match-top">
                    <span class="td-tag">${tag}</span>
                    <span class="td-date">${dateLabel}</span>
                </div>
                <div class="td-match-body">
                    <span class="td-opp">${isHome ? "vs" : "at"} ${oppLabel}</span>
                    <span class="td-result">${resultHtml}</span>
                </div>
            </div>`;
    }
    if (!rows) rows = `<div class="td-empty">No fixtures scheduled yet.</div>`;

    const overlay = document.createElement("div");
    overlay.className = "anim-overlay team-details";
    overlay.innerHTML = `
        <div class="td-card">
            <button class="anim-close" aria-label="Close">&times;</button>
            <div class="td-header">
                <span class="td-flag">${team.flag}</span>
                <div class="td-headtext">
                    <div class="td-name">${escapeHtml(team.name)}</div>
                    ${owner ? `<div class="td-owner">${escapeHtml(owner)}</div>` : ""}
                </div>
            </div>
            <div class="td-status ${statusClass}">${statusText}</div>
            <div class="td-journey-label">Their journey</div>
            <div class="td-matches">${rows}</div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".anim-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function onEsc(e) {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
    });
    requestAnimationFrame(() => overlay.classList.add("show"));
}

// ---- Effective team state: auto results (LIVE), with admin overrides on top ----
function isEliminated(name) {
    const o = state.overrides[name];
    if (o && typeof o.eliminated === "boolean") return o.eliminated;
    return (LIVE.eliminated || []).includes(name);
}

function getStage(name) {
    const o = state.overrides[name];
    if (o && o.stage) return o.stage;
    return (LIVE.stages || {})[name] || "groups";
}

// ---- Spots badge ----
function renderSpotsBadge() {
    const taken = Math.max(0, Math.min(SPOTS_TAKEN, TOTAL_SPOTS));
    document.getElementById("spots-taken").textContent = taken;
    document.getElementById("spots-total").textContent = TOTAL_SPOTS;
}

// ---- Tabs ----
function setupTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(tab.dataset.tab).classList.add("active");
            if (tab.dataset.tab === "fixtures") scrollFixturesToToday(true);
        });
    });
}

// ---- Render Groups ----
function renderGroups() {
    const grid = document.getElementById("groups-grid");
    grid.innerHTML = "";

    for (const [groupName, teams] of Object.entries(WORLD_CUP_DATA.groups)) {
        const card = document.createElement("div");
        card.className = "group-card";

        let teamsHTML = "";
        for (const team of teams) {
            const owner = state.assignments[team.name];
            const eliminated = isEliminated(team.name);
            const ownerDisplay = owner
                ? `<span class="team-owner">${escapeHtml(owner)}</span>`
                : `<span class="team-owner unassigned">Available</span>`;

            teamsHTML += `
                <div class="team-row${eliminated ? ' eliminated' : ''}">
                    <span class="team-flag">${team.flag}</span>
                    <span class="team-name">${team.name}</span>
                    ${state.drawComplete ? ownerDisplay : ''}
                </div>`;
        }

        card.innerHTML = `
            <div class="group-header">Group ${groupName}</div>
            ${teamsHTML}`;
        grid.appendChild(card);
    }
}

// ---- Render Bracket ----
function renderBracket() {
    const view = document.getElementById("bracket-view");
    view.innerHTML = "";

    const activeStage = document.querySelector(".stage-btn.active")?.dataset.stage || "groups";

    const allTeams = getAllTeams();
    const filteredTeams = filterTeamsByStage(allTeams, activeStage);

    if (filteredTeams.length === 0) {
        view.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 2rem;">
            No teams at this stage yet. The tournament hasn't reached here!
        </div>`;
        return;
    }

    for (const team of filteredTeams) {
        const eliminated = isEliminated(team.name);
        const owner = state.assignments[team.name];
        const stage = getStage(team.name);

        const card = document.createElement("div");
        card.className = `bracket-team ${eliminated ? 'eliminated' : 'alive'} is-clickable`;
        card.dataset.teamClick = team.name;
        card.innerHTML = `
            <span class="team-flag">${team.flag}</span>
            <div class="bracket-team-info">
                <div class="bracket-team-name">${team.name}</div>
                ${owner ? `<div class="bracket-team-owner">${escapeHtml(owner)}</div>` : ''}
            </div>
            <span class="bracket-team-stage">${getStageName(stage)}</span>`;
        view.appendChild(card);
    }

    // Stage button listeners
    document.querySelectorAll(".stage-btn").forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll(".stage-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderBracket();
        };
    });
}

function filterTeamsByStage(teams, viewStage) {
    const stageOrder = ["groups", "r32", "r16", "qf", "sf", "final", "winner"];
    const viewIdx = stageOrder.indexOf(viewStage);

    if (viewStage === "groups") return teams;

    // A team belongs in a stage view only if it actually reached that stage;
    // eliminated teams still show (greyed out) at the stages they got to.
    return teams.filter(t => {
        const teamStage = getStage(t.name);
        const teamIdx = stageOrder.indexOf(teamStage);
        return teamIdx >= viewIdx;
    });
}

function getAllTeams() {
    const teams = [];
    for (const group of Object.values(WORLD_CUP_DATA.groups)) {
        teams.push(...group);
    }
    return teams;
}

function getStageName(stage) {
    const names = {
        groups: "Groups",
        r32: "R32",
        r16: "R16",
        qf: "QF",
        sf: "Semi",
        final: "Final",
        winner: "WINNER!"
    };
    const safeStage = normalizeStage(stage);
    return names[safeStage];
}

// ---- Fixtures / internal calendar ----
function teamFlag(name) {
    for (const team of getAllTeams()) {
        if (team.name === name) return team.flag;
    }
    return "";
}

// Friendly label for an unresolved placeholder like "2A", "3A/B/C/D/F", "W73", "L101".
function placeholderLabel(ref) {
    let m;
    if ((m = /^1([A-L])$/.exec(ref))) return `Winner Group ${m[1]}`;
    if ((m = /^2([A-L])$/.exec(ref))) return `Runner-up Group ${m[1]}`;
    if (/^3[A-L/]+$/.test(ref)) return "3rd place";
    if ((m = /^W(\d+)$/.exec(ref))) return `Winner of #${m[1]}`;
    if ((m = /^L(\d+)$/.exec(ref))) return `Loser of #${m[1]}`;
    return ref;
}

function fixtureSide(match, side) {
    const rec = RESULTS[String(match.match)] || {};
    const resolved = rec[side];                    // filled in by the engine as rounds finish
    const ref = side === "home" ? match.home : match.away;
    const placeholder = side === "home" ? match.homePlaceholder : match.awayPlaceholder;
    const name = resolved || (placeholder ? null : ref);
    if (name) {
        const owner = state.assignments[name];
        return {
            name,
            html: `<span class="fx-flag">${teamFlag(name)}</span>
                   <span class="fx-team-name${isEliminated(name) ? ' eliminated' : ''}">${escapeHtml(name)}</span>
                   ${owner ? `<span class="fx-owner">${escapeHtml(owner)}</span>` : ""}`,
        };
    }
    return { name: null, html: `<span class="fx-team-name tbd">${escapeHtml(placeholderLabel(ref))}</span>` };
}

const STAGE_LABEL_LONG = {
    group: "Group Stage", r32: "Round of 32", r16: "Round of 16",
    qf: "Quarter-final", sf: "Semi-final", third: "Third-place play-off", final: "Final",
};

function renderFixtures() {
    const view = document.getElementById("fixtures-view");
    if (!view) return;

    if (!SCHEDULE.length) {
        view.innerHTML = `<div class="fx-empty">Fixture calendar unavailable.</div>`;
        return;
    }

    if (LIVE.updatedAt) {
        const updated = new Date(LIVE.updatedAt);
        document.getElementById("fixtures-updated").textContent =
            `Results auto-update ~2 hours after each match finishes. Last update: ${updated.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`;
    }

    const now = Date.now();
    const byDate = {};
    for (const m of SCHEDULE) {
        (byDate[m.ukDate] = byDate[m.ukDate] || []).push(m);
    }

    const today = todayUKDate();
    let html = "";
    for (const date of Object.keys(byDate).sort()) {
        const d = new Date(date + "T12:00:00Z");
        const isToday = date === today;
        html += `<div class="fx-day${isToday ? ' today' : ''}" id="fxday-${date}" data-date="${date}">
            ${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
            ${isToday ? '<span class="fx-today-pill">Today</span>' : ''}
        </div>`;
        for (const m of byDate[date].sort((a, b) => a.match - b.match)) {
            const rec = RESULTS[String(m.match)] || {};
            const finished = rec.status === "FINISHED";
            const due = now >= Date.parse(m.resultsDueUTC);
            const home = fixtureSide(m, "home");
            const away = fixtureSide(m, "away");

            let middle, statusClass;
            if (finished && rec.homeScore != null) {
                // Coerce to numbers: results.json is machine-written from an
                // external feed, so never trust it as HTML.
                middle = `<span class="fx-score">${Number(rec.homeScore)} – ${Number(rec.awayScore)}</span>`;
                statusClass = "done";
            } else if (due) {
                middle = `<span class="fx-vs">v</span>`;
                statusClass = "due";
            } else {
                middle = `<span class="fx-ko">${m.ukTime}</span>`;
                statusClass = "upcoming";
            }

            const tag = m.stage === "group"
                ? `Group ${escapeHtml(m.group)}`
                : (STAGE_LABEL_LONG[m.stage] || escapeHtml(m.stage));
            const note = finished ? "Full time"
                : due ? "Awaiting result"
                : `${m.ukTime} BST`;

            const sideAttrs = (s, sideName) => {
                const cls = `fx-side ${sideName}${s.name ? ' is-clickable' : ''}`;
                const extra = s.name
                    ? ` data-team-click="${escapeHtml(s.name)}" role="button" tabindex="0"`
                    : '';
                return `class="${cls}"${extra}`;
            };
            html += `
                <div class="fx-match ${statusClass}">
                    <div class="fx-meta"><span class="fx-tag">${tag}</span><span class="fx-num">#${m.match}</span></div>
                    <div class="fx-teams">
                        <div ${sideAttrs(home, "home")}>${home.html}</div>
                        <div class="fx-mid">${middle}</div>
                        <div ${sideAttrs(away, "away")}>${away.html}</div>
                    </div>
                    <div class="fx-foot"><span class="fx-venue">${escapeHtml(m.venue)}</span><span class="fx-status">${note}</span></div>
                </div>`;
        }
    }
    view.innerHTML = html;
}

// Today's date as an ISO yyyy-mm-dd string in UK time, to match m.ukDate.
function todayUKDate() {
    // en-CA gives ISO-style yyyy-mm-dd; Europe/London keeps us aligned with ukDate.
    return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

// Jump the fixtures list to today (or the next day with matches, or — once the
// tournament is over — the last day), so you don't have to scroll from June 11.
function scrollFixturesToToday(smooth = false) {
    const view = document.getElementById("fixtures-view");
    if (!view) return;
    const days = [...view.querySelectorAll(".fx-day")];
    if (!days.length) return;

    const today = todayUKDate();
    // First day that is today or still to come; fall back to the very last day.
    const target = days.find(el => el.dataset.date >= today) || days[days.length - 1];
    target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

// ---- Draw Status ----
function updateDrawStatus() {
    const el = document.getElementById("draw-status");
    if (state.drawComplete) {
        el.innerHTML = `<span class="status-badge complete">Draw complete! Good luck everyone!</span>`;
    } else {
        el.innerHTML = `<span class="status-badge pending">Draw not yet made - watch this space!</span>`;
    }
}

// ---- Bank details ----
function updateBankDetails() {
    const sortEl = document.getElementById("sort-code");
    const accEl = document.getElementById("account-no");
    if (sortEl) sortEl.textContent = state.bankSortCode;
    if (accEl) accEl.textContent = state.bankAccountNo;
}

// ---- Admin ----
function setupAdmin() {
    if (!isAdmin) return;

    document.getElementById("admin-panel").classList.remove("hidden");
    document.getElementById("bracket-admin").classList.remove("hidden");

    // Draw button
    document.getElementById("run-draw-btn").addEventListener("click", runDraw);
    document.getElementById("clear-draw-btn").addEventListener("click", clearDraw);
    document.getElementById("export-btn").addEventListener("click", exportData);
    document.getElementById("import-btn").addEventListener("click", () => {
        document.getElementById("import-file").click();
    });
    document.getElementById("import-file").addEventListener("change", importData);

    // Bracket admin
    populateTeamSelects();
    document.getElementById("eliminate-btn").addEventListener("click", eliminateTeam);
    document.getElementById("reinstate-btn").addEventListener("click", reinstateTeam);
    document.getElementById("advance-btn").addEventListener("click", advanceTeam);
}

function runDraw() {
    const input = document.getElementById("participants-input").value.trim();
    if (!input) {
        alert("Enter some names first!");
        return;
    }

    const names = input.split("\n").map(n => n.trim()).filter(n => n.length > 0);
    const teams = getAllTeams();

    if (names.length > teams.length) {
        alert(`Too many names! You have ${names.length} names but only ${teams.length} teams.`);
        return;
    }

    // Shuffle teams (Fisher–Yates with a CSPRNG — there's money on this draw)
    const shuffled = [...teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Assign
    state.assignments = {};
    for (let i = 0; i < names.length; i++) {
        state.assignments[shuffled[i].name] = names[i];
    }
    state.drawComplete = true;

    // Initialize stages
    state.stages = {};
    for (const team of teams) {
        state.stages[team.name] = "groups";
    }

    saveState(state);

    // Animate
    animateDraw(names, shuffled).then(() => {
        renderGroups();
        renderBracket();
        updateDrawStatus();
        populateTeamSelects();
        launchConfetti();
    });
}

async function animateDraw(names, shuffledTeams) {
    const animDiv = document.getElementById("draw-animation");
    const slotName = document.getElementById("slot-name");
    const slotTeam = document.getElementById("slot-team");
    animDiv.classList.remove("hidden");

    for (let i = 0; i < names.length; i++) {
        slotName.classList.add("spinning");
        slotTeam.classList.add("spinning");

        // Spin for a bit
        const spinTime = 600 + Math.random() * 400;
        const spinInterval = setInterval(() => {
            slotName.textContent = names[Math.floor(Math.random() * names.length)];
            slotTeam.textContent = shuffledTeams[Math.floor(Math.random() * shuffledTeams.length)].name;
        }, 50);

        await sleep(spinTime);
        clearInterval(spinInterval);

        slotName.classList.remove("spinning");
        slotTeam.classList.remove("spinning");
        slotName.textContent = names[i];
        slotTeam.textContent = shuffledTeams[i].name;

        await sleep(800);
    }
}

function clearDraw() {
    if (!confirm("Clear the entire draw? This cannot be undone!")) return;
    state = getDefaultState();
    saveState(state);
    renderGroups();
    renderBracket();
    updateDrawStatus();
    populateTeamSelects();
}

function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sweepstake-data.json";
    a.click();
    URL.revokeObjectURL(url);
}

function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            state = { ...getDefaultState(), ...data };
            saveState(state);
            renderGroups();
            renderBracket();
            updateDrawStatus();
            updateBankDetails();
            populateTeamSelects();
            alert("Data imported!");
        } catch {
            alert("Invalid JSON file!");
        }
    };
    reader.readAsText(file);
}

function populateTeamSelects() {
    const teams = getAllTeams();
    const eliminateSelect = document.getElementById("eliminate-team");
    const advanceSelect = document.getElementById("set-stage-team");

    [eliminateSelect, advanceSelect].forEach(sel => {
        const firstOpt = sel.options[0];
        sel.innerHTML = "";
        sel.appendChild(firstOpt);
        for (const team of teams) {
            const opt = document.createElement("option");
            opt.value = team.name;
            const owner = state.assignments[team.name];
            opt.textContent = `${team.flag} ${team.name}${owner ? ` (${owner})` : ''}`;
            sel.appendChild(opt);
        }
    });
}

// Admin actions write to the overrides layer, which takes precedence over the
// auto-updated results (so the organiser can correct a wrong/late feed by hand).
function setOverride(name, patch) {
    state.overrides[name] = { ...(state.overrides[name] || {}), ...patch };
    saveState(state);
}

function eliminateTeam() {
    const name = document.getElementById("eliminate-team").value;
    if (!name) return;
    if (!isEliminated(name)) {
        setOverride(name, { eliminated: true });
        const team = findTeam(name);
        playEliminationAnimation(team).then(() => {
            renderGroups();
            renderBracket();
            renderFixtures();
        });
    }
}

function reinstateTeam() {
    const name = document.getElementById("eliminate-team").value;
    if (!name) return;
    setOverride(name, { eliminated: false });
    renderGroups();
    renderBracket();
    renderFixtures();
}

function advanceTeam() {
    const name = document.getElementById("set-stage-team").value;
    const stage = normalizeStage(document.getElementById("set-stage-to").value);
    if (!name) return;
    const previousStage = getStage(name);
    setOverride(name, { stage, eliminated: false });
    const team = findTeam(name);
    playAdvanceAnimation(team, previousStage, stage).then(() => {
        renderBracket();
        renderFixtures();
    });
}

function findTeam(name) {
    return getAllTeams().find(t => t.name === name);
}

// ---- Confetti ----
function launchConfetti() {
    const canvas = document.getElementById("confetti-canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const pieces = [];
    const colors = ["#ffffff", "#e0e0e0", "#b0b0b0", "#808080", "#555555", "#333333", "#cccccc"];

    for (let i = 0; i < 150; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            w: Math.random() * 10 + 5,
            h: Math.random() * 6 + 3,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 3,
            vy: Math.random() * 3 + 2,
            rot: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 10
        });
    }

    let frame = 0;
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;

        for (const p of pieces) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.05;
            p.rot += p.rotSpeed;

            if (p.y < canvas.height + 50) alive = true;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }

        frame++;
        if (alive && frame < 300) {
            requestAnimationFrame(animate);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    animate();
}

// ---- Elimination: half-mast flag ----
function playEliminationAnimation(team) {
    if (!team) return Promise.resolve();
    const owner = state.assignments[team.name];
    const overlay = document.createElement("div");
    overlay.className = "anim-overlay elimination";
    overlay.innerHTML = `
        <div class="anim-stage">
            <div class="flagpole">
                <div class="pole-top"></div>
                <div class="pole"></div>
                <div class="pole-base"></div>
                <div class="flag-hoist" id="elim-flag">
                    <div class="flag-cloth">
                        <span class="flag-emoji">${team.flag}</span>
                        <span class="flag-name">${escapeHtml(team.name)}</span>
                    </div>
                </div>
            </div>
            <div class="anim-caption">
                <div class="anim-title">Going Home</div>
                <div class="anim-sub">${escapeHtml(team.name)} eliminated${owner ? ` &mdash; commiserations ${escapeHtml(owner)}` : ''}</div>
            </div>
        </div>
        <button class="anim-close" aria-label="Close">&times;</button>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".anim-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    return new Promise(resolve => {
        // Trigger the descent
        requestAnimationFrame(() => {
            overlay.classList.add("show");
            setTimeout(() => {
                overlay.querySelector("#elim-flag").classList.add("half-mast");
            }, 600);
        });
        setTimeout(() => {
            overlay.classList.add("fade-out");
            setTimeout(() => { close(); resolve(); }, 500);
        }, 4200);
    });
}

// ---- Advancement: march toward the trophy ----
const STAGE_PROGRESS = {
    groups: 0,
    r32: 1,
    r16: 2,
    qf: 3,
    sf: 4,
    final: 5,
    winner: 6
};

function normalizeStage(stage) {
    return Object.prototype.hasOwnProperty.call(STAGE_PROGRESS, stage) ? stage : "groups";
}

function playAdvanceAnimation(team, fromStage, toStage, opts = {}) {
    if (!team) return Promise.resolve();
    const review = !!opts.review;
    const owner = state.assignments[team.name];
    const fromIdx = STAGE_PROGRESS[fromStage] ?? 0;
    const toIdx = STAGE_PROGRESS[toStage] ?? 0;
    // Real advancements need to actually move; review mode plays even at equal stages.
    if (!review && toIdx <= fromIdx) return Promise.resolve();

    const stagesPath = ["Groups", "R32", "R16", "QF", "Semi", "Final", "🏆"];
    const totalSteps = 6;
    const startPct = (fromIdx / totalSteps) * 100;
    const endPct = (toIdx / totalSteps) * 100;
    const isWinner = toStage === "winner";
    const stillInGroups = review && toIdx === 0;
    const title = isWinner ? 'CHAMPIONS!'
        : review
            ? (stillInGroups ? 'Still flying the flag' : `Marching on!`)
            : 'Through to the next round!';
    const sub = isWinner ? `${escapeHtml(team.name)} lift the Jules Rimet!`
        : review
            ? (stillInGroups
                ? `${escapeHtml(team.name)} are in the group stage`
                : `${escapeHtml(team.name)} are currently in the ${getStageName(toStage)}`)
            : `${escapeHtml(team.name)} march on to the ${getStageName(toStage)}`;
    const ownerLine = owner
        ? (isWinner || !review ? ` &mdash; well played ${escapeHtml(owner)}!` : ` &mdash; come on ${escapeHtml(owner)}!`)
        : '';

    const overlay = document.createElement("div");
    overlay.className = "anim-overlay advance" + (isWinner ? " winner" : "");
    overlay.innerHTML = `
        <div class="anim-stage advance-stage">
            <div class="march-track">
                <div class="march-pitch"></div>
                <div class="march-checkpoints">
                    ${stagesPath.map((s, i) => `
                        <div class="checkpoint${i <= toIdx ? ' reached' : ''}${i === toIdx ? ' active' : ''}">
                            <div class="checkpoint-dot"></div>
                            <div class="checkpoint-label">${s}</div>
                        </div>
                    `).join("")}
                </div>
                <div class="trophy-target">
                    <div class="trophy-glow"></div>
                    <div class="trophy-icon">🏆</div>
                </div>
                <div class="march-lane">
                    <div class="marcher" id="adv-marcher" style="--start: ${startPct}%; --end: ${endPct}%;">
                        <div class="marcher-flag">${team.flag}</div>
                        <div class="marcher-name">${escapeHtml(team.name)}</div>
                    </div>
                </div>
            </div>
            <div class="anim-caption">
                <div class="anim-title">${title}</div>
                <div class="anim-sub">${sub}${ownerLine}</div>
            </div>
        </div>
        <button class="anim-close" aria-label="Close">&times;</button>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".anim-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    return new Promise(resolve => {
        requestAnimationFrame(() => {
            overlay.classList.add("show");
            setTimeout(() => {
                overlay.querySelector("#adv-marcher").classList.add("marching");
            }, 400);
            if (isWinner) {
                setTimeout(() => launchConfetti(), 1800);
            }
        });
        const duration = isWinner ? 5200 : 4200;
        setTimeout(() => {
            overlay.classList.add("fade-out");
            setTimeout(() => { close(); resolve(); }, 500);
        }, duration);
    });
}

// ---- Helpers ----
// Unbiased random integer in [0, max) using the Web Crypto API,
// with rejection sampling to avoid modulo bias.
function randomInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do {
        crypto.getRandomValues(buf);
        x = buf[0];
    } while (x >= limit);
    return x % max;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
    // Must escape quotes too: escaped values are interpolated into HTML
    // attributes (e.g. data-team-click="...") as well as text content.
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
