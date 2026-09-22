---
name: sprint-list-experiment-launch-sync
description: Syncs a Slack List's experiment rows with Houston release-plan/launch activity, updating stale row notes and posting a change log to the channel. Use when asked to sync the Sprint List experiment launch status, refresh experiment notes on the Slack List, or check linked Houston experiments for new rollout/launch steps. Requires the Houston MCP server.
---

# Sprint List Experiment Launch Sync

### *This skill was generated using AI, which can produce inaccurate or harmful responses. Review for accuracy and safety before using.*

## How It Works

ALWAYS: Reads the target Slack List (schema + items), reads each linked Houston experiment's release plan and history, and updates any list rows whose notes are missing recent launch/rollout activity. CONNECTED: Requires the Houston MCP server to be enabled. If it is not connected, say so plainly, suggest connecting it, and stop — this skill cannot meaningfully run without Houston data.

## Steps

**Phase 1 — Scope the request.** The target list is always [this Slack List](https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?view_id=View0BRHEPA1NY). This skill does not read a saved view by name — instead, replicate the "With Experiments" view's scope by applying these two filters directly when reading the list: (1) the "Status" field does NOT include any of [:check:, :blocked2:, :backlog2:, :canceled:], AND (2) the "Experiment" column is not empty. Every row matching both filters is in scope regardless of any other field. Identify any additional filter scope the user names on top of this.

**Phase 2 — Gather list rows.** Read the list schema first (schema_only=true) to get exact column IDs/keys for the "Status" field (and its option IDs for :check:, :blocked2:, :backlog2:, :canceled:) and the "Experiment" column (or equivalent), plus any domain/view filter column the user names. Then read the list rows. IMPORTANT: `slack_read_list` has NO server-side filter parameters — you cannot narrow by Status or Experiment at read time. Read ALL rows (paginating with the returned cursor until `next_cursor` is empty — the list is ~150+ rows, so expect ~2 pages at limit=100) and apply the Phase 1 filters client-side yourself: keep only rows whose Status is not one of the four excluded options AND whose Experiment column is non-empty. Request `format: "csv"` on these reads — it is materially lighter than the default markdown table and lowers token load on the large read. Note each in-scope row's record_id, primary name, and the experiment name(s)/link(s)/IDs found in its Experiment column free text.

When parsing the Experiment column, only treat bare toggle names (e.g. `omni_merged`) as Houston experiments to look up. Skip entries that are raw Slack file links (`F0…`) or Houston summary/experiment URLs pasted as free text — file links are not lookupable by experiment name, and a URL already carries its own ID. A row whose Experiment column contains only such links (no bare toggle name) has nothing to look up; note it as "no experiment linked" in the chat reply and move on.

**Writing a cell destroys every link and every strikethrough in it. This cannot be worked around.** Verified empirically against this list:
* `slack_update_list_record` stores **plain text only**. Writing `[name](url)` stores the literal characters `[name](url)`; writing `~~name~~` stores literal tildes. There is no rich-text write path.
* `slack_read_list` does not expose links in EITHER format. A `format: "markdown"` read of all 160 rows returned **zero** `[name](url)` links, even for cells that definitely contain hyperlinks. The read cannot tell a linked `omni_merged` from an unlinked one.
* `slack_update_list_record` replaces the whole cell value; there is no way to append to a cell without rewriting it.

Together these mean a link is **undetectable before the write and unrecoverable after it**. Do NOT try to "re-read in markdown to preserve the link" — an earlier version of this skill said to do exactly that, and it does not work, because the link is not in the read output to begin with. Any earlier instruction of that form was wrong; trust this section.

Strikethrough IS visible in the read (as `~name~`, Slack mrkdwn single tildes). Links are not. So strikethrough can be detected and protected; links can only be protected by the do-not-write list below.

**Skip crossed-out (archived) experiments.** A toggle name rendered with strikethrough in the Slack List means that experiment has been archived — it will never roll out again, so there is nothing new to sync into the notes. In the read output, strikethrough surfaces as a single-tilde span (`~toggle_name~`, Slack mrkdwn). Silently skip any struck-through toggle name — never search it, fetch its release plan, or look it up in Houston. This is a pure optimization that avoids wasted lookups. When a row lists several toggle names and only some are struck through, skip only the struck-through ones and still check the rest.

A `~...~` span is also a **write blocker for the whole cell**: rewriting that cell would flatten the strikethrough into literal tildes. Detecting tildes therefore does double duty — skip the lookup, and mark the cell do-not-write (see Phase 4).

**Phase 3 — Bulk-check Houston.** First build the distinct set of experiments to check: collect every bare toggle name across all in-scope rows and dedupe. Deduping is per experiment, not per row — if the same experiment appears on multiple rows (e.g. `srp_ia_next_filters` on two rows), look it up ONCE and reuse that single result for every row that references it.

Then fetch concurrently, not one-by-one. Split the deduped experiment set into batches (roughly 5-8 experiments each) and dispatch the batches to parallel subagents (Agent tool, general-purpose) that each search the experiment by name and fetch **all three** of its release plan (`get_release_plan`), its details/history (`get_experiment_details`, which embeds `ts_metadata.history[]`), and its group overrides (`get_group_assignments` with `includeDeleted: true`). This is the main efficiency lever — a serial walk of ~30-40 experiments is slow; parallel batches finish in a fraction of the time.

**Always fetch group overrides too — they are a third mandatory source, invisible to the other two.** Alongside the release plan and details/history, every lookup must call `get_group_assignments(experimentId, includeDeleted: true, limit: 1000)`. Group overrides (Houston's "Group Overrides" panel) are how a feature is force-enabled for a specific channel, team, or membership group before any percentage ramp, and they appear in **neither** `planned_rollout_steps[]` **nor** `ts_metadata.history[]`.

`member_id_type` is the UI's "Member Type" / "Channel Type" column. **Report `channel` rows only. Ignore `user`, `team`, `membership_group`, and `generic` rows entirely.** `user` entries are routine dogfooding noise; the rest are audience overrides that this change log does not track. This is deliberately a hard type filter rather than a judgement call — an earlier draft said to report `team`/`membership_group` "when the row's notes track audience targeting," which is untestable and would also have fed non-channel rows into the channel-shaped bullet below (printing a workspace name with a `#` prefix and a bogus user count). Filter on `member_id_type == "channel"` before the collapse step, not after.

For each channel override, read:
* `member.name` (e.g. `proj-find-in-thread`) and `member.encoded_id` (e.g. `C0ARHPK0Q1X`) — identify the channel by name, never by the raw `member_id_int`
* `member.num_users` — the size of the exposed audience
* `group` — which variant the channel was forced into (e.g. `on`)
* `date_create` (raw int) — when the override went live
* `date_delete` (raw int; `0` means still active) — when it was removed
* `ts_user` — who made the change

**Use `get_group_assignments`, not `export_group_assignments`.** The export variant returns only currently-active members as comma-joined ID strings with **no timestamps and no deleted rows**, so it cannot date an override or show that one was removed. It is useless for a change log.

**Collapse override churn — report the state change, not each row.** Re-saving the same channel creates a brand-new row every time, so one channel can hold several rows seconds apart. `find_in_thread` has four rows for `#proj-find-in-thread`, created 6/9 and then three times within three minutes on 8/5 as it was deleted and re-added. That is ONE channel rollout that began 6/9 and is still active, not four events. Group a channel's rows by `member.encoded_id`, sort by `date_create`, and report the earliest `date_create` of the current unbroken active run plus a genuine removal only when the channel's latest row has a non-zero `date_delete`. Never emit a bullet per row.

**Group overrides do NOT advance `date_update` and do NOT appear in `history[]` — verified.** `slackbot_agent_chat_layout` (11994179299009) had a group assignment created 9/18 13:52 PT while its `date_update` still read 9/4 and its `history[]` held only the original `create` entry. `texty_autocomplete_files` has a `#team-messaging-members-only` channel override created 6/23 08:24 PT that appears nowhere in its history. Two consequences, both load-bearing:
* **The Phase 3.5 `date_update` freshness gate cannot gate this call.** An experiment whose `date_update` is unchanged may still have gained or lost a channel override. Always call `get_group_assignments` for every in-scope experiment, even one the gate would otherwise let you skip.
* **The Phase 3.5 self-check must ignore override timestamps.** A channel override dated later than `date_update` is normal and is NOT evidence of a missed `history[]` event — do not go hunting in `history[]` for it, and never feed an override timestamp into the `date_update` comparison.

**Always fetch history — it is NOT a fallback for sparse release plans.** All three sources (plan, history, overrides) are mandatory on every lookup, because they carry different events: the release plan has ramps, and `history[]` has lifecycle and condition changes that appear nowhere else. An experiment can have a perfectly full release plan and still have its most important event (a conclude, a pause) only in history — `omni_suggestion_matching` last ramped 6/3 but was concluded 8/14, and treating history as a fallback loses that entirely. Never skip the history fetch because the plan "looks complete."

**Subagents return RAW INTEGER timestamps — never calendar dates.** Have each subagent return, per experiment:
* `name`, `id`, Houston `url`, `lifecycle.category` (verbatim string)
* `date_update`: raw `experiment.date_update` integer (the freshness gate needs this)
* for every release-plan step: raw `date_launched` integer verbatim, plus `group_rollout_percents`/`launch_group`, `status`, and the full condition set (raw numeric IDs are fine)
* for every `ts_metadata.history[]` entry: its raw `ts` integer, its `action` string, and enough of `args` to tell what changed (the `conditions` object, and `args.group` for `finish_experiment`)
* for every group override with `member_id_type: "channel"` (skip all other types): `member.name`, `member.encoded_id`, `member.num_users`, `group`, `ts_user`, and raw `date_create` / `date_delete` integers. Subagents must return every row verbatim — they must NOT dedupe the churn, decide which run is current, or convert the timestamps. The main agent collapses the runs in code.

Subagents must NOT convert epochs to M/D, must NOT say "8/13", and must NOT pick a max, sort by date, or decide which event is "latest." Emit raw integers and let the main agent reduce them — two subagents reading the same payload have returned different answers for "the largest ts," one of them wrong. All epoch→date conversion happens once, in code, in the main agent (see "Convert epochs in code" below).

**Why:** LLM arithmetic on 10-digit epochs is silently unreliable — it has produced calendar dates that appear nowhere in the payload. A real failure on `ml_qu_ministral_fine_tuned`: the notes were written as 8/10 (25%), 8/11 (50%), and 8/13 (100%) when Houston's actual `date_launched` values were 8/12, 8/13, and 8/17. Neither 8/10 nor 8/11 corresponded to any timestamp in the experiment, in any timezone — they were invented. The same class of error, from the same cause, is documented in the sibling `stale-experiments-report` skill.

Skip cheaply where a lookup cannot produce an update:
* A `draft` or `scheduled` experiment with an empty release plan, no launch history, **and no channel group override** has never rolled out — it needs no update. These are common and each one still costs a lookup, so note them and move on rather than deep-diving. **Check the overrides before applying this skip:** a draft with an empty `schedule[]` can still be live in a specific channel. `find_in_thread` (10899039040432) is exactly this case — lifecycle `draft`, zero release-plan steps, a `history[]` holding only `create` and one `update_metadata`, yet `#proj-find-in-thread` (24 users) has been forced to `on` since 6/9. Skipping on "draft + empty plan" alone silently loses that rollout, which is the whole reason overrides are fetched.
* An experiment that is `finished`/`archived` AND whose row notes already reflect its concluding step will never change again — it is safe to skip on future runs.

**Which date field is authoritative — `date_launched`, never `date_planned`.** Each entry in `planned_rollout_steps[]` carries four timestamps, and picking the wrong one is the single largest source of wrong dates in this skill:

| Field | Meaning | Use it? |
|---|---|---|
| `date_launched` | When the step **actually shipped** | ✅ **This is the only date to report** |
| `date_planned` | When someone *intended* to ship it | ❌ Never — nothing fires when it passes |
| `date_created` | When the step row was added to the plan | ❌ Never |
| `date_updated` | Last mutation of the row, for any reason | ❌ Never |

A step with `date_launched: 0` has **not shipped yet** — skip it entirely, never report it as a launch (and never substitute its `date_planned`). `status: 1` means launched, and it travels with a non-zero `date_launched`; treat the two as one condition. If you ever see a non-zero `date_launched` under a different status, trust `date_launched` (the step shipped) and note the anomaly in the chat reply rather than dropping the step.

`date_planned` and `date_launched` diverge as the norm, not the exception — they differed on most sampled steps, sometimes by weeks. On `ml_qu_ministral_fine_tuned` the 25% step was planned for 7/2 but did not launch until 8/12, a 41-day gap; reporting `date_planned` there would be wrong by six weeks. Houston's own docs are explicit that a planned rollout launches deliberately and "nothing fires on date_planned."

**Cross-check `date_launched` against history.** For a launched step, the corresponding `add_schedule_item`/`update_schedule_item` entry in `ts_metadata.history[]` has a `ts` matching that step's `date_launched` — two independent confirmations of the same event. Compare them, but expect **off-by-one-second skew**: Houston writes the two records in separate statements, so 1786724541 vs 1786724540 is normal and not a discrepancy. Treat them as agreeing if they land on the same calendar day; only flag a genuine disagreement (different days). Do this comparison in the same `python3` pass that converts the epochs — compare the two rendered `%-m/%-d` strings, never by eye. When days genuinely differ, do NOT silently pick one: report it in the chat reply and use the `history[].ts` value (history is an append-only audit trail).

**Ignore removed schedule items — but never the removal event itself.** `history[]` can contain `add_schedule_item`/`update_schedule_item` entries for segments later deleted via `remove_schedule_item`. Those *ramp* timestamps describe rollouts that no longer exist, so they must not be reported as live launch steps — reconcile history against the *current* release plan and drop the `add_schedule_item`/`update_schedule_item` entries whose schedule item was subsequently removed. This dropping applies ONLY to those two ramp actions: the `remove_schedule_item` event is itself a real, reportable event (and is often the experiment's latest activity), so keep it and report it as "rollout removed."

**`date_launched` covers ramps, but NOT lifecycle events — take those from `history[]` actions.** Concluding, pausing, and archiving an experiment produce no `planned_rollout_steps[]` entry at all, so a `date_launched`-only walk silently loses them and reports an experiment's last activity as its final *ramp* instead of its actual conclusion. Always also scan `ts_metadata.history[]` for these actions and date each by its own entry `ts`:

| History action | Report as |
|---|---|
| `finish_experiment` | concluded to `args.group` (e.g. "concluded to on") |
| `pause_experiment` | paused |
| `rollback_schedule_item` | rolled back |
| `remove_schedule_item` | rollout removed |
| `edit_global_conditions` | global conditions changed |

**Some history actions advance `date_update` without being reportable rollout events** — `update_metadata` (a summary/description/channel_name edit) and `create` are the common ones. These are NOT posted to the change log, but they DO satisfy the Phase 3.5 self-check: record them as `latest_activity_ts`/`latest_activity` in the checkpoint so the invariant converges. Without this, an experiment whose newest event is a metadata edit trips the self-check on every future run and can never be reconciled — `find_in_thread` is exactly this case, its `date_update` of 9/18 belonging to a `update_metadata` that set `channel_name`.

Real examples of what a launch-only walk loses: `omni_suggestion_matching` last *ramped* 6/3 but was **concluded to `on` on 8/14**; `search_semantic_timestamp_sort` last ramped 4/13 but was **paused 4/22**. In both cases 6/3 and 4/13 are the wrong "latest activity" — the lifecycle event is later and is the thing worth reporting. Many of these experiments also have `date_launched: 0` on every step (the rollout was driven straight from the schedule), so their entire history lives in `history[]` and nowhere else.

So: **launch/ramp dates come from `date_launched`; lifecycle and condition changes come from `history[]` action entries.** An experiment's latest activity is the max across both, computed in code.

**Also capture condition-only changes, which have no release-plan step at all.** An `update_schedule_item` history entry whose `args` contains a `schedule_item` but NO `planned_rollout_step` is a real, reportable event: the conditions or targeting changed without a percentage ramp. These are invisible if you only walk `planned_rollout_steps[]`. Diff the `conditions` object against the previous history entry's and report what changed, dated by that entry's `ts` — e.g. on `ml_qu_ministral_fine_tuned` an 8/27 entry removed the `membership_groups NONE_OF [Release Train Sandbox, Release Train GA]` exclusion, widening the audience, with no ramp and no plan step. Word these as the change they are (e.g. "removed membership group exclusion"), not as a launch.

Membership-group and team ID reference (Houston returns numeric IDs; these are the recurring ones for this list — use them instead of re-deriving each run, but confirm against lifecycle strings if a new ID appears): Membership Group **1 = Release Train Sandbox**, **2 = Release Train GA**, **11 = TS Dogfood**, **12 = Search Friends Of**. Team **265193767125 = Salesforce (E7T5PNK3P)**, **4908545423204 = Salesforce Sandbox (E04SQG1CF60)**. If an ID is not in this table, resolve it with `get_experiment_conditions` (which returns the full `membership_groups` and `team` option maps) — never guess a name or omit the condition.

**Convert epochs to dates in code, once, in the main agent.** After the subagents return raw integers, convert every `date_launched`/`ts` in a SINGLE `Bash` call and use only its output in notes and the channel post. Never convert by hand, never eyeball an epoch, never trust a date a subagent wrote.

```bash
python3 - <<'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
PT = ZoneInfo("America/Los_Angeles")
# (experiment, label, raw date_launched epoch) straight from the subagent output
rows = [
    ("ml_qu_ministral_fine_tuned", "25%/25%", 1786562722),
    ("ml_qu_ministral_fine_tuned", "50%/50%", 1786649049),
    ("ml_qu_ministral_fine_tuned", "100% treatment", 1787000153),
]
for name, label, ts in rows:
    if not ts:            # date_launched == 0 -> not shipped, skip
        continue
    print(f"{name}\t{label}\t{datetime.fromtimestamp(ts, PT):%-m/%-d}")
PY
```

Collapse and date channel overrides in the SAME code pass — group the raw rows by channel, take the current run's earliest `date_create`, and report a removal only when the newest row for that channel has a non-zero `date_delete`:

```python
from itertools import groupby
CHURN = 86400   # a re-add within a day of its delete is a re-save, not a new rollout
# (experiment, encoded_id, name, num_users, group, date_create, date_delete) - raw ints from subagents
rows.sort(key=lambda r: (r[0], r[1], r[5]))
for (exp, cid), g in groupby(rows, key=lambda r: (r[0], r[1])):
    g = list(g)
    latest = g[-1]
    if latest[6] == 0:                     # still active: date the current unbroken run
        run_start = g[0][5]
        for prev, cur in zip(g, g[1:]):    # only a REAL gap restarts the run
            if prev[6] and cur[5] - prev[6] > CHURN:
                run_start = cur[5]
        print(f"{exp}\t#{latest[2]}\t{latest[4]}\t{latest[3]} users\tsince {datetime.fromtimestamp(run_start, PT):%-m/%-d}")
    else:                                  # removed: report the removal, dated by date_delete
        print(f"{exp}\t#{latest[2]}\tREMOVED {datetime.fromtimestamp(latest[6], PT):%-m/%-d}")
```

**The `CHURN` tolerance is required, not cosmetic — verified.** Without it, `find_in_thread` reports 8/5 instead of 6/9. Its four `#proj-find-in-thread` rows were created at 1781019371, 1785978110, 1785978165, and 1785978220, and the third was deleted at 1785978207 — **13 seconds** before the fourth was created. A bare `cur[5] > prev[6]` test treats that 13-second window as a genuine removal-and-relaunch and restarts the run at 8/5, hiding two months of exposure. With the one-day tolerance the same data collapses to the correct single line: active since 6/9. Re-saving an override is a normal UI action that deletes and recreates the row, so sub-day gaps are never real rollout boundaries.

**Convert in US/Pacific (`America/Los_Angeles`), not UTC.** This list's existing notes follow Pacific. Verified against every dated entry in the checkpoint: Pacific reproduces 21/21 of the known-correct dates while UTC reproduces 20/21 — a late-afternoon Pacific launch (e.g. `search_answers_slackbot` at 1789526222) rolls over to the next UTC day and would be written a day late. Pin ONE timezone for every conversion in a run so a late-evening launch never lands on two different calendar days across rows:

```python
from zoneinfo import ZoneInfo
PT = ZoneInfo("America/Los_Angeles")
print(f"{datetime.fromtimestamp(ts, PT):%-m/%-d}")
```

Use `datetime.fromtimestamp(ts, tz)` — `utcfromtimestamp` is deprecated; macOS `date` has no `-d @`, use `date -r <ts>`.

**Do not use `get_recent_rollouts` as a freshness pre-filter — it cannot do this job.** Two independent reasons:
* Its `hours` parameter is capped at **168 (7 days)**, so any step older than a week is structurally invisible. An experiment that launched 8/17 simply cannot be surfaced by it on a 9/18 run.
* It keys on schedule segments whose `ts` is frozen at rollout *start*: Houston creates one `schedule[]` item per rollout and mutates it in place on every subsequent ramp without advancing its `ts`. So a long-running experiment that has ramped repeatedly looks untouched since its first day. `schedule[]` is not append-only; only `history[]` is.

Relying on it causes exactly the silent-skip failure this skill must avoid: the pre-filter reports "nothing recent," the deep-dive is skipped, and a stale or wrong note is never corrected. Use the `date_update` gate in Phase 3.5 instead. `get_all_planned_launches` is still fine for forward-looking context, but never as the gate that decides whether to skip an experiment.

For each rollout/launch step, capture the FULL set of Houston conditions applied — not just the variant and percentage, but every additional condition such as membership group, audience, or other targeting criteria attached to that step. IMPORTANT — decision trees with multiple branches: an experiment's release plan may contain several distinct if/else rollout branches (e.g. one branch scoped to a membership group like "Search Friends Of", another scoped to a different membership group like "TS Dogfood", another scoped only to a variant like "Commercial"). Treat each branch as its own separate rollout with its own launch date — never merge branches into one date/condition set, and never apply one branch's date to another branch's condition. Walk the entire decision tree and record every branch individually: its condition/type (membership group, variant, audience, etc.) and the date that specific branch was launched. Compare the actual rollout/launch steps (dates + percentages/variant + membership group + any other conditions + conclude events), branch by branch, against what is already written in the row's Experiment column text. Build a per-experiment list of any steps (per branch) that are newer or otherwise absent from the existing notes, or whose existing note is missing a condition (e.g. a membership group) or misattributes a date across branches. An experiment with no release plan and no relevant history entries needs no update.

**Phase 3.5 — Checkpoint state (optional but recommended for repeat runs).** To avoid re-fetching every release plan from scratch on every run, persist a small checkpoint file keyed by experiment name recording the latest launch/rollout activity seen for each experiment (and its terminal status if finished/archived).

**Store raw integer epochs, not `"M/D"` strings.** Each entry records:
* `latest_launched_ts` — largest `date_launched` seen (the last **ramp**)
* `latest_activity_ts` + `latest_activity` — the last activity of ANY kind when a lifecycle/condition event postdates the last ramp (conclude, pause, archive, condition change). Write these whenever such an event exists; omit them when the last ramp *is* the last activity.
* `date_update_ts` — `experiment.date_update` at the time of the run, the integer the freshness gate compares
* `channel_overrides` — one entry per distinct channel that has ever been overridden: `{encoded_id, name, group, active_since_ts, removed_ts}`, with `removed_ts: null` while active. These must be checkpointed separately because `date_update_ts` cannot detect a change to them: an override added or removed since the last run leaves `date_update` untouched, so the ONLY way to notice is to diff this list against a fresh `get_group_assignments` call every run. Never fold an override timestamp into `latest_activity_ts` — that field feeds the `date_update` invariant, and an override would break it.

  **Write `"channel_overrides": []` when an experiment genuinely has none — never omit the key.** An absent key means "not yet checked" and an empty array means "checked, has none," and the two must be distinguishable: if absence were treated as "has none," the first run after this change would diff a long-standing override against nothing and post it as a brand-new rollout. On encountering an experiment with no `channel_overrides` key, fetch its overrides and report anything found as **pre-existing** (state the real `active_since` date, which may be months old) rather than as newly added.

An `"8/13"` string is lossy (no year, no time), cannot be compared numerically, and if it was ever written from a hand-converted epoch it silently preserves that error forever. Keep human-readable `latest_step`/`latest_activity` copies alongside for skimming, but the integers are what the gate compares — never compare or edit the rendered strings by hand. A checkpoint entry whose date came from an older, unverified run should be treated as suspect — re-derive it rather than trusting it.

**The invariant compares `date_update_ts` against `max(latest_launched_ts, latest_activity_ts)`, not against `latest_launched_ts` alone.** For a concluded or paused experiment the last activity is a `history[].ts` with no corresponding ramp, so comparing against the ramp alone would flag it as "missing an event" on every future run and never converge.

**The freshness gate is `date_update`, not `get_recent_rollouts`.** For each experiment already in the checkpoint, call `get_experiment_details` (cheap, one call) and compare `experiment.date_update` to the checkpointed `date_update_ts`:
* `date_update` unchanged → no ramp, lifecycle, or condition change has happened; skip the release-plan fetch. **Still call `get_group_assignments`** and diff against the checkpointed `channel_overrides` — overrides do not touch `date_update`, so this is the one fetch the gate can never skip.
* `date_update` newer → something changed; do the full Phase 3 deep-dive (plan + history + overrides).

The one exception to "always call `get_group_assignments`" is an experiment already checkpointed as finished/archived with its conclude step noted: that is skipped in full, overrides included, since a concluded experiment will not roll out again.

`date_update` advances on every mutation including condition-only changes — **except group-assignment writes, its one blind spot** (see Phase 3) — so unlike `get_recent_rollouts` it has no lookback window and no frozen-timestamp problem for ramps and lifecycle events. Do the numeric comparison in code alongside the Phase 3 conversion, never by eye.

Experiments marked finished/archived in the checkpoint whose conclude step is already in the notes can be skipped entirely — a concluded experiment's overrides no longer matter. Update the checkpoint at the end of each run, writing the epochs actually derived in this run. If no checkpoint exists yet (first run), fetch everything as in Phase 3 and write the checkpoint as you go.

**Self-check before writing the checkpoint: `date_update_ts` must never exceed the latest reported activity.** Compute this against ramps and lifecycle events only — **exclude group-override timestamps from both sides of the comparison**, since overrides never move `date_update` and mixing them in produces false passes and false failures alike. After deriving each experiment's steps, compare `experiment.date_update` against the latest timestamp you are about to report. If `date_update` is later, something happened that you did not capture — almost always a lifecycle or condition event that has no rollout step (conclude, pause, archive, `edit_global_conditions`). Go back to `history[]` and find it rather than shipping the earlier date. This one numeric comparison catches the entire class of "reported the last ramp instead of the real last activity" bugs, and it is how the 8/14 conclude on `omni_suggestion_matching` and the 4/22 pause on `search_semantic_timestamp_sort` were recovered.

**Never let the checkpoint launder a bad date.** The checkpoint is a cache of what a previous run *believed*, not a source of truth about Houston. If a run's derived `date_launched` disagrees with the checkpoint, Houston wins — correct the notes and overwrite the checkpoint. A wrong checkpointed date combined with a skip-if-unchanged gate is self-perpetuating: the bad note is never revisited. This is precisely how `ml_qu_ministral_fine_tuned` kept a wrong 8/13 for the 100% launch across runs.

**Phase 4 — Update only what's stale.** For each row where Houston shows steps not reflected in the notes, append/rewrite that row's Experiment column with the missing steps added, keeping existing content and links intact and formatting new steps consistently with the existing style (bullet per date + action). When a row has multiple experiments listed, separate each experiment's block with one blank line so they stay easy to read. Batch all row updates for the list into as few write calls as possible. Never touch rows that are already current.

**Do not write a cell whose formatting would be destroyed — report it for manual edit instead.** Because a write flattens the entire cell to plain text (see Phase 2), skip the write and hand the user ready-to-paste text when EITHER condition holds:

1. **The cell contains strikethrough** — any `~...~` span in the read output.
2. **The cell is on the do-not-write list** in the checkpoint (`no_write_records`), which names records known to contain hyperlinks. Links are invisible in the read, so this list is the only defense; it is maintained by hand as link-bearing rows are discovered.

For a skipped row, add it to the **Needs manual update** section of the chat reply with the row link, the experiment name, and the exact bullets to paste. Never write the cell "carefully" to work around this — there is no careful write; the flattening is unconditional.

When a cell has NO strikethrough and is NOT on the do-not-write list, write it normally, building the new value from the read value plus the new bullets.

**Never emit markup that the write path will store literally.** No `[name](url)`, no `~~name~~`, no `~name~`. If the value you assembled contains any of those, you have reconstructed rich text that will be stored as visible garbage — strip it to plain text first. Mark an archived experiment with a plain-text ` (archived)` suffix after the toggle name; never re-emit tildes.

After any write, read the cell back and confirm it contains no literal `](`, `~~`, or stray `~`. If it does, you wrote markup — rewrite the cell as clean plain text immediately.

Apply the eligible row updates automatically — never pause to ask the user to confirm or approve them. Skipped rows are reported, not queued for approval.

**Phase 5 — Write the log.** Always post to <#C0BRA11HAE9>, whether or not any rows were updated, so there's a record the skill ran. When there is something to post, post the summary of changes to <#C0BRA11HAE9> instead of replying in the Slackbot chat — do not create a canvas unless the user asks for one. Never include a "No changes needed" section (or any list of untouched/already-current rows) in the channel post — that detail belongs only in the chat reply back to the user, never in the channel log. When posting, disable link unfurling/attachments (unfurl_links and unfurl_media both off) so no preview cards appear under the links. Format the post exactly as follows:

Post this log automatically once ready — **_never ask the user to confirm or approve before posting to the channel_**.

1. A link to the Slack List itself, on its own line, i.e. post the slugified link version: [list](https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?view_id=View0BRHEPA1NY)
2. A bolded line: **Updated (N rows):** where N is the count of rows that actually received new content (rows left untouched because they had no missing steps are never counted or listed here).
3. One top-level bullet per updated row, containing only the row's list-item link (e.g. `https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?record_id=<record_id>`) as the bullet text — no row name or extra text on this line.
    1. Nested one level under each row bullet: one bullet per experiment that was updated on that row, formatted as a link using the experiment's name as link text and its Houston experiment URL as the link (e.g. `[experiment_name](https://houston.tinyspeck.com/experiments/<id>)`). Only list experiments that actually had new steps added — never list an experiment that was checked but had nothing new.
    2. Nested one level under each experiment bullet: one bullet per newly-added event, always including the date, the percentage/variant, AND the full list of every other condition applied (membership group, audience, etc.) — never report the variant alone when an additional condition applies. When an experiment's decision tree has multiple distinct rollout branches, report each branch as its OWN bullet with its OWN date; never combine branches or apply one branch's date to another's condition. Word each bullet as the event it actually is, not always as a "launch":
        * added 8/14 launch (100%, Commercial, Membership Group: Search Friends Of)
        * added 8/17 launch (100%, Commercial, Membership Group: TS Dogfood)
        * added 8/21 launch (50%, Commercial)
        * added 8/14 conclusion (concluded to on)
        * added 4/22 pause
        * added 8/27 condition change (removed membership group exclusion: Release Train Sandbox, Release Train GA)
        * added 6/9 channel rollout (#proj-find-in-thread, 24 users, forced to on)
        * added 8/5 channel rollout removed (#team-messaging-members-only)

Word a channel override as a **channel rollout**, never as a plain "launch" and never with a percentage — it is a targeted force-on for one channel, not a ramp, and giving it a percentage misrepresents it. Name the channel with a `#` prefix from `member.name`, include `member.num_users`, and name the forced `group`. Emit at most one bullet per channel per state change (see the churn-collapsing rule in Phase 3), and never emit a bullet for any non-`channel` override type. When an override is discovered on an experiment that had no `channel_overrides` key in the checkpoint, word it as pre-existing with its true start date (e.g. "noted pre-existing channel rollout (#proj-find-in-thread, 24 users, forced to on, active since 6/9)") — do not imply it just happened.

Example of the exact structure to follow:

> **[list](https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?view_id=View0BRHEPA1NY)**
> **Updated (2 rows):**
> 
> * [https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?record_id=Rec0BNBECC3BL](https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?record_id=Rec0BNBECC3BL)
>     * [slackbot_agentic_search_partition](https://houston.tinyspeck.com/experiments/11820351523985)
>         * added 8/14 launch (50%/50%, Commercial)
>     * [slackbot_search_as_code](https://houston.tinyspeck.com/experiments/11566801804177)
>         * added 8/18 launch (33%/33%/34%, Commercial)
> * [https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?record_id=Rec0BGJ3Z0162](https://salesforce.enterprise.slack.com/lists/T024BE7LD/F0A619NPXD5?record_id=Rec0BGJ3Z0162)
>     * [omni_lazy_explain](https://houston.tinyspeck.com/experiments/11331434214899)
>         * added 8/14 launch (50%, Commercial)
>     * [emoji_picker_searcher_class](https://houston.tinyspeck.com/experiments/11797091561909)
>         * added 8/17 launch (10%/10%, Commercial)

If a row had missing steps but could not be written (write rejected, unrecoverable link, ambiguous experiment name), add a **Could not update:** section after the row bullets: one bullet per such row with its list-item link and a plain-language reason. Omit the section entirely when every intended write succeeded.

If any error occurred while running the skill (list read/write failure, Houston connection error, etc.), add an **Errors:** section describing what happened in plain language, even if it means the run only partially completed.

If zero rows had any missing steps, still post to the channel to confirm the skill ran — post the list link followed by a bolded line **Updated (0 rows):** and nothing else (no row/experiment/step bullets). Separately, tell the user in the chat reply that everything in scope was already current.

## Output

A chat reply with:

* One line stating how many rows were reviewed (view scope) and how many were updated.
* If at least one row was updated: the channel log post itself follows the exact structure described in Phase 5 (list link, then **Updated (N rows):** with nested row/experiment/step bullets, then any **Could not update:** or **Errors:** sections as needed) — do not restate that structure differently here, and never include a "No changes needed" section in it.
* If zero rows were updated: still post to the channel (list link + **Updated (0 rows):**) to confirm the skill ran, and also say so in this chat reply.
* **No changes needed:** (chat reply only, never in the channel post) one line naming the rows checked but left alone, with the reason (already current, no release plan, or no experiment linked).
* **Needs manual update:** (chat reply only) one entry per row skipped because a write would destroy a link or strikethrough. Give the row link, the experiment name, and the exact plain-text bullets to paste, so the user can apply it in the UI in one copy. State the reason plainly ("cell contains a hyperlink that a write would flatten"). Never silently drop these rows, and never count them under **Updated (N rows):**.
* If Houston is not connected or a named list/view can't be found: state that clearly instead of guessing, and stop before Phase 4.

## Key Principles

* Never invent or estimate a launch date or percentage — only report what Houston's release plan/history actually returns.
* **`date_launched` is the only launch date.** Never report `date_planned`, `date_created`, or `date_updated`; they routinely differ from the real ship date by days or weeks. A step with `date_launched: 0` has not shipped — skip it. Cross-check against the matching `history[].ts`, allowing for one-second write skew.
* **Never convert a Unix epoch by hand, and never let a subagent convert one.** Subagents return raw integers only; the main agent converts them all in one `Bash`/`python3` call. Hand arithmetic on epochs has produced dates that exist nowhere in the payload (8/10 and 8/11 were reported for steps that actually launched 8/12 and 8/13).
* **Every conversion uses `America/Los_Angeles`.** Pacific reproduces 21/21 known-correct dates in this list; UTC reproduces 20/21, writing late-afternoon Pacific launches a day late. Pin the one timezone for the whole run.
* **Each decision-tree branch gets its own date.** A release plan with several if/else branches is several rollouts; never merge them into one bullet or apply one branch's date to another branch's condition.
* **Drop `add_schedule_item`/`update_schedule_item` ramps for schedule items later removed** — those rollouts no longer exist. The `remove_schedule_item` event itself still gets reported.
* **Condition-only changes are reportable events.** An `update_schedule_item` with no `planned_rollout_step` changed targeting without a ramp, and is invisible if you only walk release-plan steps. Report it as a condition change, dated by its history `ts`.
* **Lifecycle events have no rollout step.** `finish_experiment`, `pause_experiment`, `rollback_schedule_item`, `remove_schedule_item`, and `edit_global_conditions` exist only in `history[]`, so a `date_launched`-only walk reports an experiment's last *ramp* as its last activity and silently loses the conclusion. Many experiments have `date_launched: 0` on every step, making `history[]` their only record.
* **Channel group overrides are rollouts, and they live in a third source.** `get_group_assignments(includeDeleted: true)` is mandatory on every lookup: an override appears in neither `planned_rollout_steps[]` nor `history[]`, and it does **not** advance `date_update` (verified — `slackbot_agent_chat_layout` gained an assignment on 9/18 while `date_update` still read 9/4). So the `date_update` gate can never skip this call, and override timestamps must be excluded from the `date_update` invariant and from `latest_activity_ts`. Use `get_group_assignments`, never `export_group_assignments` — the latter has no timestamps and omits deleted rows.
* **Only `member_id_type: "channel"` is a channel rollout.** Filter on `member_id_type == "channel"` before collapsing; `user`, `team`, `membership_group`, and `generic` rows are all ignored by this skill. Report a channel override as a "channel rollout" naming `#member.name`, `member.num_users`, and the forced `group` — never with a percentage, because it is a targeted force-on and not a ramp.
* **A draft with an empty release plan can still be rolled out.** Check overrides before applying the draft-skip: `find_in_thread` is lifecycle `draft` with zero plan steps yet has been live in `#proj-find-in-thread` since 6/9.
* **Collapse override churn in code with a one-day tolerance.** Re-saving an override deletes and recreates the row, so one channel yields many rows; `find_in_thread` has four for one channel, three within three minutes. Group by channel and report one state change. A bare "any gap restarts the run" test reads a 13-second delete/re-add window as a relaunch and reports 8/5 instead of 6/9 — hiding two months of exposure.
* **Invariant: `date_update` must never be later than the latest activity you report.** If it is, a lifecycle or condition event was missed — find it in `history[]` before writing anything. One numeric comparison, catches a whole bug class.
* **Never use `get_recent_rollouts` to decide whether to skip an experiment** — its 168-hour cap and rollout-start-frozen timestamps make it structurally blind to older activity. Gate on `experiment.date_update` versus the checkpoint instead.
* **The checkpoint is a cache, not a source of truth.** When it disagrees with Houston, Houston wins: fix the notes and overwrite the checkpoint. Store raw epochs so a bad hand-converted date cannot persist across runs.
* Resolve every numeric condition ID to its name (`get_experiment_conditions` has the full maps) — never guess a membership group or team name, and never drop a condition because its ID is unfamiliar.
* Preserve existing row notes; this skill adds missing information, it doesn't rewrite or delete what's already accurate.
* **A write flattens the whole cell to plain text, and this is not fixable.** `slack_update_list_record` stores plain text only, and neither read format exposes hyperlinks (a markdown read of all 160 rows returned zero `[name](url)`). So a link cannot be detected before a write or recovered after one. Never attempt the "re-read in markdown to preserve the link" workaround — it was tried, it does not work.
* **Skip the write when formatting is at stake.** A cell with a `~...~` span (detectable) or listed in the checkpoint's `no_write_records` (hand-maintained, for invisible hyperlinks) is never written — report it under **Needs manual update** with paste-ready bullets.
* **Never emit `[name](url)`, `~~name~~`, or `~name~` in a cell value** — they are stored literally and render as visible garbage. Mark archived experiments with a plain-text ` (archived)` suffix. Read every written cell back and check for literal `](`, `~~`, or stray `~`.
* Only touch rows matching the Phase 1 filter (Status excludes :check:/:blocked2:/:backlog2:/:canceled: AND Experiment is not empty) — leave every other row untouched.
* Skip crossed-out (struck-through) toggle names entirely — strikethrough means the experiment was archived and will never roll out again, so looking it up is wasted work.
* Never ask the user to confirm or approve posting to the channel. Just post it.
* Once posted, remove any and all unfurl attachments that may have been posted to the channel.
* Efficiency: `slack_read_list` cannot filter server-side — read all rows (CSV format) and filter client-side. Dedupe experiments before looking them up and reuse a single lookup across every row that references that experiment. Fetch experiments in parallel batches, not serially. Skip drafts with no release plan **and no channel override**, plus finished/archived experiments whose conclude step is already noted. Prefer a checkpoint + `date_update` comparison over re-fetching every plan each run — but `get_group_assignments` always runs, since overrides do not move `date_update` — never `get_recent_rollouts`, whose 168-hour cap silently hides older activity.
