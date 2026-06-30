#!/usr/bin/env python3
"""
World Cup 2026 Sweepstake - automatic results updater.

Runs on a schedule (GitHub Actions). For every match whose result is "due"
(kickoff + 4h, i.e. ~2h play + 2h buffer for extra time / penalties) it pulls
the final score from a live-scores feed and writes it into results.json. It then
derives the full tournament state - group standings, who qualifies, and the
knockout bracket - into tracker-state.json, which the website reads to show
eliminations and how far each team (and therefore each sweepstake entrant) got.

Data sources, in order of precedence (highest first):
  1. manual-results.json ({"<matchNo>": "2-1", ...}) - hand-entered, always wins.
  2. openfootball/worldcup.json - free, public-domain JSON on GitHub. No API key,
     no rate limit. This is the default automatic feed, so results flow with zero
     configuration. (https://github.com/openfootball/worldcup.json)
  3. football-data.org v4 - optional supplement, used only if FOOTBALL_DATA_API_TOKEN
     is set. Fills any match the openfootball feed hasn't published yet.

The script is deliberately fail-soft: any network/parse problem is logged and the
run still exits 0 with whatever it could update, so a flaky feed never turns the
schedule red.
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEDULE = os.path.join(ROOT, "schedule.json")
RESULTS = os.path.join(ROOT, "results.json")
STATE = os.path.join(ROOT, "tracker-state.json")
MANUAL = os.path.join(ROOT, "manual-results.json")

API_TOKEN = os.environ.get("FOOTBALL_DATA_API_TOKEN", "").strip()
API_COMP = (os.environ.get("FOOTBALL_DATA_COMPETITION") or "WC").strip()
API_BASE = "https://api.football-data.org/v4"

# Free, public-domain results feed (no token, no rate limit) - the default source.
# Override via OPENFOOTBALL_URL if the path ever moves.
OPENFOOTBALL_URL = (os.environ.get("OPENFOOTBALL_URL") or
                    "https://raw.githubusercontent.com/openfootball/worldcup.json"
                    "/master/2026/worldcup.json").strip()

# Map provider team names onto the canonical names used in data.js / schedule.json.
ALIASES = {
    "czech republic": "Czechia",
    "korea republic": "South Korea",
    "south korea": "South Korea",
    "republic of korea": "South Korea",
    "iran": "IR Iran",
    "ir iran": "IR Iran",
    "turkey": "Türkiye",
    "turkiye": "Türkiye",
    "united states": "United States",
    "usa": "United States",
    "united states of america": "United States",
    "bosnia & herzegovina": "Bosnia and Herzegovina",
    "bosnia and herzegovina": "Bosnia and Herzegovina",
    "ivory coast": "Ivory Coast",
    "cote d'ivoire": "Ivory Coast",
    "côte d'ivoire": "Ivory Coast",
    "cape verde": "Cape Verde",
    "cabo verde": "Cape Verde",
    "dr congo": "DR Congo",
    "congo dr": "DR Congo",
    "curacao": "Curaçao",
    "curaçao": "Curaçao",
}


def now_utc():
    # SWEEPSTAKE_NOW lets tests pin the clock (ISO8601, e.g. 2026-06-28T23:30:00Z).
    override = os.environ.get("SWEEPSTAKE_NOW", "").strip()
    if override:
        return parse_iso(override)
    return datetime.now(timezone.utc)


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def dump(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def canon(name, valid):
    """Best-effort map an external team name to a canonical schedule name."""
    if not name:
        return None
    key = name.strip().lower()
    if key in ALIASES:
        return ALIASES[key]
    for v in valid:
        if v.lower() == key:
            return v
    # last resort: substring either direction
    for v in valid:
        vl = v.lower()
        if vl in key or key in vl:
            return v
    return None


# --------------------------------------------------------------------------
# Fetching final scores
# --------------------------------------------------------------------------
def _http_json(url, headers=None):
    """GET a URL and parse JSON, or return None on any network/parse failure."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as e:
        print(f"Fetch failed for {url} ({e}); continuing with existing data.")
        return None


def _clean_score(pair):
    """Return (home, away) if pair is two plain non-negative ints, else None.

    These are the only feed-supplied values written to results.json (which the
    website renders), so a hostile/garbled feed can't smuggle anything else through.
    """
    if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
        return None
    h, a = pair[0], pair[1]
    if not isinstance(h, int) or not isinstance(a, int):
        return None
    if isinstance(h, bool) or isinstance(a, bool):
        return None
    if h < 0 or a < 0:
        return None
    return h, a


def fetch_openfootball_matches():
    """Return finished matches from openfootball/worldcup.json, or [] on failure.

    No API token required. Score format is {"ft": [h, a], "et": [...], "p": [...]}.
    We display the after-extra-time score when present, else full-time, and read
    the penalty shootout (if any) to decide a knockout level after ET/90'."""
    data = _http_json(OPENFOOTBALL_URL)
    if not data:
        return []
    out = []
    for m in data.get("matches", []):
        score = m.get("score") or {}
        final = _clean_score(score.get("et")) or _clean_score(score.get("ft"))
        if final is None:
            continue  # not played yet (or unparseable)
        h, a = final
        pens = None
        if h > a:
            winner = "HOME_TEAM"
        elif a > h:
            winner = "AWAY_TEAM"
        else:
            pens = _clean_score(score.get("p"))
            if pens and pens[0] != pens[1]:
                winner = "HOME_TEAM" if pens[0] > pens[1] else "AWAY_TEAM"
            else:
                winner = "DRAW"  # genuine group-stage draw
                pens = None
        out.append({
            "home": m.get("team1"),
            "away": m.get("team2"),
            "homeScore": h,
            "awayScore": a,
            "winner": winner,
            "pens": pens,  # (home, away) shootout score, only on a knockout draw
            "utcDate": m.get("date"),
        })
    print(f"openfootball returned {len(out)} finished match(es).")
    return out


def fetch_openfootball_ko_pairs():
    """Return {team1: team2, team2: team1} for every Round-of-32 fixture the feed
    lists, played or not.

    The eight best third-placed teams are sent to specific R32 slots by a fixed
    official table. Our schedule only records the *set* of groups allowed in each
    slot (e.g. "3A/B/C/D/F"), which several valid permutations can satisfy - so a
    blind assignment can pair a third-placed team with the wrong opponent, and the
    feed's real result for that team then never matches our fixture. The feed
    already publishes the actual pairings, so we use them to pin each third-placed
    team to the exact slot the official bracket uses."""
    data = _http_json(OPENFOOTBALL_URL)
    pairs = {}
    if not data:
        return pairs
    for m in data.get("matches", []):
        if (m.get("round") or "") != "Round of 32":
            continue
        t1, t2 = m.get("team1"), m.get("team2")
        if t1 and t2:
            pairs[t1] = t2
            pairs[t2] = t1
    return pairs


def fetch_api_matches():
    """Return finished matches from football-data.org, or [] on failure.

    Optional supplement: only runs if a token is set. The free tier may not
    cover the World Cup, so this is a best-effort gap-filler, not the primary feed.
    """
    if not API_TOKEN:
        print("No FOOTBALL_DATA_API_TOKEN set - skipping optional API fetch.")
        return []
    url = f"{API_BASE}/competitions/{API_COMP}/matches?status=FINISHED"
    data = _http_json(url, headers={"X-Auth-Token": API_TOKEN})
    if not data:
        return []
    out = []
    for m in data.get("matches", []):
        ft = (m.get("score") or {}).get("fullTime") or {}
        final = _clean_score((ft.get("home"), ft.get("away")))
        if final is None:
            continue
        out.append({
            "home": (m.get("homeTeam") or {}).get("name"),
            "away": (m.get("awayTeam") or {}).get("name"),
            "homeScore": final[0],
            "awayScore": final[1],
            "winner": (m.get("score") or {}).get("winner"),  # HOME_TEAM/AWAY_TEAM/DRAW
            "utcDate": m.get("utcDate"),
        })
    print(f"API returned {len(out)} finished match(es).")
    return out


def _index_by_pair(feed, valid, idx, override=True):
    """Index feed matches by the frozenset of their two canonical team names.

    With override=False, existing entries are kept (used so a supplemental feed
    only fills gaps the primary feed left)."""
    for a in feed:
        h, w = canon(a["home"], valid), canon(a["away"], valid)
        if not (h and w):
            continue
        key = frozenset((h, w))
        if override or key not in idx:
            idx[key] = a
    return idx


def valid_teams(schedule):
    """The canonical names of every team that appears as a concrete (non-placeholder)
    side anywhere in the schedule."""
    valid = {m["home"] for m in schedule if not m["homePlaceholder"]}
    valid |= {m["away"] for m in schedule if not m["awayPlaceholder"]}
    return valid


def build_feed_idx(valid):
    """Index every finished feed match by the frozenset of its two team names.

    Primary feed: openfootball (free, no token). football-data.org only fills
    matches openfootball hasn't published yet, so it never overrides it."""
    feed_idx = {}
    _index_by_pair(fetch_openfootball_matches(), valid, feed_idx)
    _index_by_pair(fetch_api_matches(), valid, feed_idx, override=False)
    return feed_idx


def canonical_pairs(raw_pairs, valid):
    """Map a feed {team: opponent} dict onto canonical schedule names, dropping any
    pair whose names we can't resolve (e.g. unplayed-round placeholders)."""
    out = {}
    for a, b in raw_pairs.items():
        ca, cb = canon(a, valid), canon(b, valid)
        if ca and cb:
            out[ca] = cb
    return out


def apply_results(schedule, results, feed_idx):
    """Fill results.json for any due match: manual file first, then the live feed."""
    valid = valid_teams(schedule)
    manual = load(MANUAL, {}) or {}
    now = now_utc()
    changed = 0

    for m in schedule:
        no = str(m["match"])
        rec = results["results"][no]
        if rec.get("status") == "FINISHED":
            # Backfill a shootout score onto a knockout draw that was recorded
            # before we tracked penalties, so the site can show how it was decided.
            if (rec.get("winner") and rec.get("homeScore") is not None
                    and rec["homeScore"] == rec["awayScore"]
                    and rec.get("penaltyHome") is None
                    and rec.get("home") and rec.get("away")):
                a = feed_idx.get(frozenset((rec["home"], rec["away"])))
                if a and a.get("pens"):
                    p = a["pens"]
                    flip = canon(a["home"], valid) != rec["home"]
                    rec["penaltyHome"], rec["penaltyAway"] = (p[1], p[0]) if flip else (p[0], p[1])
            continue
        due = parse_iso(m["resultsDueUTC"])
        if now < due:
            continue  # not enough time has passed since this match finished

        home = rec.get("home")
        away = rec.get("away")

        # 1) manual override wins, e.g. "2-1" (orientation = home-away of this match)
        if no in manual and isinstance(manual[no], str):
            mm = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", manual[no])
            if mm:
                _set_result(rec, int(mm.group(1)), int(mm.group(2)))
                changed += 1
                continue
            print(f"Bad manual result for match {no}: {manual[no]!r}")

        # 2) live feed (only once both teams are known, i.e. not still a placeholder)
        if home and away:
            a = feed_idx.get(frozenset((home, away)))
            if a:
                if canon(a["home"], valid) == home:
                    _set_result(rec, a["homeScore"], a["awayScore"], a.get("winner"),
                                pens=a.get("pens"))
                else:
                    _set_result(rec, a["awayScore"], a["homeScore"], a.get("winner"),
                                flip=True, pens=a.get("pens"))
                changed += 1

    print(f"Updated {changed} match result(s).")
    return changed


def _set_result(rec, home_score, away_score, api_winner=None, flip=False, pens=None):
    rec["homeScore"] = home_score
    rec["awayScore"] = away_score
    rec["status"] = "FINISHED"
    rec["finishedAt"] = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")
    # default: clear any stale shootout score; set below only on a knockout draw
    rec.pop("penaltyHome", None)
    rec.pop("penaltyAway", None)
    if home_score > away_score:
        rec["winner"] = rec.get("home")
    elif away_score > home_score:
        rec["winner"] = rec.get("away")
    else:
        # draw on the day -> knockout decided by ET/pens; trust the API's winner flag
        if api_winner in ("HOME_TEAM", "AWAY_TEAM"):
            home_is = (api_winner == "HOME_TEAM") ^ flip
            rec["winner"] = rec.get("home") if home_is else rec.get("away")
            # record the shootout score in this match's home-away orientation
            if pens:
                ph, pa = (pens[1], pens[0]) if flip else (pens[0], pens[1])
                rec["penaltyHome"] = ph
                rec["penaltyAway"] = pa
        else:
            rec["winner"] = None  # genuine group-stage draw


# --------------------------------------------------------------------------
# Deriving the tournament state
# --------------------------------------------------------------------------
def group_table(schedule, results, group):
    rows = {}
    teams = set()
    for m in schedule:
        if m.get("group") == group:
            teams.add(m["home"])
            teams.add(m["away"])
    for t in teams:
        rows[t] = {"team": t, "played": 0, "won": 0, "drawn": 0, "lost": 0,
                   "gf": 0, "ga": 0, "gd": 0, "pts": 0}
    for m in schedule:
        if m.get("group") != group:
            continue
        rec = results["results"][str(m["match"])]
        if rec["status"] != "FINISHED":
            continue
        h, a = rec["home"], rec["away"]
        hs, as_ = rec["homeScore"], rec["awayScore"]
        for t, gf, ga in ((h, hs, as_), (a, as_, hs)):
            r = rows[t]
            r["played"] += 1
            r["gf"] += gf
            r["ga"] += ga
            r["gd"] = r["gf"] - r["ga"]
            if gf > ga:
                r["won"] += 1
                r["pts"] += 3
            elif gf == ga:
                r["drawn"] += 1
                r["pts"] += 1
            else:
                r["lost"] += 1
    # FIFA primary ranking: points, goal difference, goals for.
    # (Finer tiebreakers - head-to-head, fair play, drawing of lots - are rare
    # and not reproduced here; the website lets the admin override if needed.)
    order = sorted(rows.values(), key=lambda r: (r["pts"], r["gd"], r["gf"], r["team"]),
                   reverse=True)
    for i, r in enumerate(order):
        r["rank"] = i + 1
    return order


def assign_thirds(third_slots, qualified_thirds, forced=None):
    """Assign each R32 third-place slot a qualifying team whose group is in that
    slot's allowed set. Returns {matchNo: team} or {}.

    `forced` ({matchNo: team}) pins slots whose opponent the feed has already told
    us - those are the official pairings, so we lock them in and only backtrack to
    fill whatever the feed hasn't published yet."""
    by_group = {t["group"]: t["team"] for t in qualified_thirds}
    group_of = {t["team"]: t["group"] for t in qualified_thirds}
    forced = forced or {}

    result = {}
    used = set()
    for mno, team in forced.items():
        if team in group_of:
            result[mno] = team
            used.add(group_of[team])

    # most-constrained first; skip slots the feed already pinned
    slots = sorted((s for s in third_slots if s["match"] not in result),
                   key=lambda s: len(s["allowed"]))

    def bt(i):
        if i == len(slots):
            return True
        s = slots[i]
        for g in s["allowed"]:
            if g in by_group and g not in used:
                used.add(g)
                result[s["match"]] = by_group[g]
                if bt(i + 1):
                    return True
                used.discard(g)
                del result[s["match"]]
        return False

    return result if bt(0) else {}


def derive_state(schedule, results, prev, ko_pairs=None):
    ko_pairs = ko_pairs or {}
    by_no = {m["match"]: m for m in schedule}
    teams = sorted({m["home"] for m in schedule if not m["homePlaceholder"]} |
                   {m["away"] for m in schedule if not m["awayPlaceholder"]})

    stages = {t: "groups" for t in teams}
    eliminated = set()
    standings = {}

    # ---- Group stage ----
    groups = sorted({m["group"] for m in schedule if m.get("group")})
    thirds = []
    qualifiers = {}  # "1A" / "2A" -> team
    for g in groups:
        table = group_table(schedule, results, g)
        standings[g] = table
        complete = all(results["results"][str(m["match"])]["status"] == "FINISHED"
                       for m in schedule if m.get("group") == g)
        if complete:
            qualifiers[f"1{g}"] = table[0]["team"]
            qualifiers[f"2{g}"] = table[1]["team"]
            for t in (table[0]["team"], table[1]["team"]):
                stages[t] = "r32"
            eliminated.add(table[3]["team"])  # 4th is always out
            thirds.append({"group": g, **table[2]})

    # ---- Best third-placed teams (top 8 of 12 advance) ----
    third_team = {}  # matchNo -> team (resolves "3A/B/..." slots)
    all_groups_done = len(thirds) == len(groups) and len(groups) == 12
    if all_groups_done:
        ranked = sorted(thirds, key=lambda r: (r["pts"], r["gd"], r["gf"], r["team"]),
                        reverse=True)
        qualified_thirds = ranked[:8]
        for t in ranked[8:]:
            eliminated.add(t["team"])
        for t in qualified_thirds:
            stages[t["team"]] = "r32"
        slots = []
        for m in schedule:
            if m["stage"] == "r32" and m["awayPlaceholder"] and m["away"].startswith("3"):
                allowed = m["away"][1:].split("/")
                slots.append({"match": m["match"], "allowed": allowed})
            if m["stage"] == "r32" and m["homePlaceholder"] and m["home"].startswith("3"):
                allowed = m["home"][1:].split("/")
                slots.append({"match": m["match"], "allowed": allowed, "side": "home"})

        # Pin slots whose opponent the feed already names: the third-placed team is
        # whoever the feed pairs with this slot's (deterministic) seeded side. This
        # locks in the official bracket where a blind permutation could pick a
        # different-but-valid one and strand the feed's real result.
        group_of_third = {t["team"]: t["group"] for t in qualified_thirds}
        forced = {}
        for s in slots:
            m = by_no[s["match"]]
            seeded_ref = m["away"] if s.get("side") == "home" else m["home"]
            seeded_team = qualifiers.get(seeded_ref)
            opp = ko_pairs.get(seeded_team) if seeded_team else None
            if opp in group_of_third and group_of_third[opp] in s["allowed"]:
                forced[s["match"]] = opp
        third_team = assign_thirds(slots, qualified_thirds, forced)

        # Repair any slot we previously guessed wrong: a third-placed side filled in
        # by an earlier (feed-blind) run can be parked against the wrong opponent, so
        # its real result never matches. Overwrite from the feed-pinned assignment,
        # but never touch a tie that has already kicked off.
        for mno, team in forced.items():
            m = by_no[mno]
            rec = results["results"][str(mno)]
            side = "home" if (m["homePlaceholder"] and str(m["home"]).startswith("3")) else "away"
            if rec.get("status") != "FINISHED" and rec.get(side) != team:
                rec[side] = team

    # ---- Knockout propagation (iterate to a fixed point) ----
    KO_NEXT_STAGE = {"r32": "r16", "r16": "qf", "qf": "sf", "sf": "final", "final": "winner"}

    def resolve(ref, match):
        if ref in qualifiers:
            return qualifiers[ref]
        if re.match(r"^3[A-L/]+$", ref):
            return third_team.get(match)
        m = re.match(r"^([WL])(\d+)$", ref)
        if m:
            kind, src = m.group(1), int(m.group(2))
            rec = results["results"].get(str(src))
            if not rec or rec["status"] != "FINISHED" or not rec.get("winner"):
                return None
            win = rec["winner"]
            loser = rec["home"] if win == rec["away"] else rec["away"]
            return win if kind == "W" else loser
        return None  # already a literal team name handled elsewhere

    for _ in range(8):  # depth of the bracket; converges well before this
        progressed = False
        for m in schedule:
            if m["stage"] == "group":
                continue
            rec = results["results"][str(m["match"])]
            # fill in concrete teams as they become known
            for side, ph in (("home", m["homePlaceholder"]), ("away", m["awayPlaceholder"])):
                if rec.get(side) is None:
                    ref = m[side]
                    t = resolve(ref, m["match"]) if ph else ref
                    if t:
                        rec[side] = t
                        progressed = True
            # a knockout score applied before its teams were known can't have a
            # winner yet; recompute it now that both teams are resolved
            if (rec["status"] == "FINISHED" and not rec.get("winner")
                    and rec.get("home") and rec.get("away")
                    and rec.get("homeScore") is not None):
                if rec["homeScore"] > rec["awayScore"]:
                    rec["winner"] = rec["home"]
                    progressed = True
                elif rec["awayScore"] > rec["homeScore"]:
                    rec["winner"] = rec["away"]
                    progressed = True
            # mark stage reached + eliminate the loser of a finished tie
            if rec["status"] == "FINISHED" and rec.get("winner"):
                win = rec["winner"]
                loser = rec["home"] if win == rec["away"] else rec["away"]
                if m["stage"] != "third":
                    nxt = KO_NEXT_STAGE.get(m["stage"])
                    if nxt and stages.get(win) != nxt:
                        stages[win] = nxt
                        progressed = True
                if loser:
                    eliminated.add(loser)
        if not progressed:
            break

    # a team that reached a round but lost is eliminated; champions are not
    eliminated.discard(_champion(schedule, results))

    return {
        "updatedAt": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "auto",
        "eliminated": sorted(eliminated),
        "stages": stages,
        "standings": standings,
    }


def _champion(schedule, results):
    for m in schedule:
        if m["stage"] == "final":
            rec = results["results"][str(m["match"])]
            if rec["status"] == "FINISHED":
                return rec.get("winner")
    return None


def main():
    schedule = load(SCHEDULE)["matches"]
    results = load(RESULTS)
    prev_state = load(STATE, {})

    # Snapshot the whole results map up front; any change at all (new score, or a
    # knockout/third-place team resolved or repaired) means we persist.
    before = json.dumps(results["results"], sort_keys=True, ensure_ascii=False)

    # Fetch the feed once, then reuse it across the loop below.
    valid = valid_teams(schedule)
    feed_idx = build_feed_idx(valid)
    ko_pairs = canonical_pairs(fetch_openfootball_ko_pairs(), valid)

    # Filling a knockout score lets derive_state resolve the next round's teams,
    # which can make a further feed result matchable - and repairing a mis-pinned
    # third-place slot unblocks a result that never matched its old opponent. So
    # alternate apply/derive until nothing new lands (bounded by bracket depth).
    changed = 0
    state = None
    for _ in range(6):
        snapshot = json.dumps(results["results"], sort_keys=True, ensure_ascii=False)
        c = apply_results(schedule, results, feed_idx)
        changed += c
        state = derive_state(schedule, results, prev_state, ko_pairs)
        # Stop once a full apply+derive pass leaves results untouched - that covers
        # both "no new score" and "no team resolved/repaired this pass".
        if json.dumps(results["results"], sort_keys=True, ensure_ascii=False) == snapshot:
            break

    after = json.dumps(results["results"], sort_keys=True, ensure_ascii=False)
    if after != before:
        results["updatedAt"] = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")
        dump(RESULTS, results)
        dump(STATE, state)
        print(f"Done. {changed} new result(s); {len(state['eliminated'])} team(s) eliminated.")
    else:
        print(f"No new results. {len(state['eliminated'])} team(s) eliminated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
