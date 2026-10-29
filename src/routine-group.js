// Deterministic grouping of single-expression routines into one multi-step
// routine. Two passes, each firing only on strong structural evidence:
// numbered chains (adjacent routines sharing one numbered-step name stem
// with consecutive numbers, each feeding the next routine's inputs) and
// prerequisite chains (an adjacent consumer-first pair where the earlier
// routine consumes an intermediate the later routine produces, i.e. a
// forward reference to a prerequisite stated after its use). Anything
// ambiguous passes through untouched; callers flag each grouping for
// analyst verification. Generic syntax and structure, never names.
import { normalizeVariableKey, resolveRoutineReference, splitAssignmentSegment } from './models.js';

// A numbered step name: a non-empty stem, an optional separator, a trailing
// number, and an optional rest (`: description`). Lazy stem so `PIPE-STEP-01:
// ...` yields stem `PIPE-STEP`, separator `-`, number `01`.
const NUMBERED_STEP_NAME = /^(.*?)([\s\-_]+)?(\d{1,4})\s*([:\-–—].*)?$/;

function parseStepName(name) {
  const m = NUMBERED_STEP_NAME.exec(String(name ?? '').trim());
  if (!m) return null;
  const stem = String(m[1] ?? '').trim();
  if (!stem) return null;
  return {
    stem,
    stemKey: stem.toLowerCase().replace(/\s+/g, ' '),
    separator: m[2] ?? '',
    numText: m[3],
    num: Number.parseInt(m[3], 10),
  };
}

// A routine eligible to become one pipeline step: a single stated expression
// with no structured steps of its own.
function isStepLike(routine) {
  if ((routine?.steps ?? []).some((s) => String(s ?? '').trim())) return false;
  if ((routine?.steps_detailed ?? []).length > 0) return false;
  return String(routine?.expression_text ?? '').trim() !== '';
}

function keySet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((v) => normalizeVariableKey(v))
      .filter(Boolean)
  );
}

// True when `next` consumes a value `prev` produces, or names `prev` as a
// dependency. Either link evidences the sequential handoff.
function chainsTo(prev, next) {
  const produced = keySet(prev?.outputs ?? []);
  for (const key of keySet(next?.inputs ?? [])) {
    if (produced.has(key)) return true;
  }
  const mentions = [
    ...(next?.depends_on ?? []),
    ...(next?.dependencies ?? []).map((d) => d?.target),
  ];
  return mentions.some((dep) => dep && resolveRoutineReference([prev], dep));
}

function extendsRun(run, next) {
  const prev = run[run.length - 1];
  if (!isStepLike(prev) || !isStepLike(next)) return false;
  const a = parseStepName(prev?.name);
  const b = parseStepName(next?.name);
  if (!a || !b || a.stemKey !== b.stemKey || b.num !== a.num + 1) return false;
  return chainsTo(prev, next);
}

// Kinds that never join a prerequisite chain, even when shaped like a
// formula: illustrative examples and rule-like routines stay separate.
// Matches normalized kinds and raw extractor spellings alike (case and
// separator insensitive); anything else falls through to the shape checks.
const PREREQUISITE_EXCLUDED_KIND_WORDS = new Set([
  'worked', 'example', 'examples', 'illustration', 'illustrations',
  'condition', 'conditional', 'eligibility', 'ineligible', 'ineligibility',
]);

function prerequisiteKindExcluded(kind) {
  const key = String(kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key === 'worked_example' || key === 'condition') return true;
  return key.split(/[^a-z0-9]+/).filter(Boolean).some((w) => PREREQUISITE_EXCLUDED_KIND_WORDS.has(w));
}

// A routine eligible for prerequisite chaining: a single stated expression
// with no structured steps or conditions of its own, and not an example or
// rule by kind.
function isPrerequisiteMember(routine) {
  if (!isStepLike(routine)) return false;
  if (prerequisiteKindExcluded(routine?.kind)) return false;
  if ((routine?.conditions ?? []).some((c) => String(c ?? '').trim())) return false;
  if ((routine?.conditions_detailed ?? []).length > 0) return false;
  return true;
}

// True when `first` (earlier) consumes a value `second` (later) produces —
// a forward reference to a prerequisite stated after its use — with no
// evidence flowing the other way (which would be a cycle or ambiguity).
function isReversePair(first, second) {
  if (!isPrerequisiteMember(first) || !isPrerequisiteMember(second)) return false;
  if (!chainsTo(second, first)) return false;
  if (chainsTo(first, second)) return false;
  return true;
}

function extendsPrerequisiteRun(run, next) {
  return isReversePair(run[run.length - 1], next);
}

// Display variables the consumer reads that the producer writes, in the
// consumer's source order (evidence for the grouping warning).
function linkVariables(consumer, producer) {
  const produced = keySet(producer?.outputs ?? []);
  const seen = new Set();
  const out = [];
  for (const v of consumer?.inputs ?? []) {
    const s = String(v ?? '').trim();
    const k = normalizeVariableKey(s);
    if (!s || !k || !produced.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function namesAsDependency(consumer, producer) {
  const mentions = [
    ...(consumer?.depends_on ?? []),
    ...(consumer?.dependencies ?? []).map((d) => d?.target),
  ];
  return mentions.some((dep) => dep && resolveRoutineReference([producer], dep));
}

// Order run members producer-first (Kahn over within-run handoff edges:
// variable flow plus dependency naming, mirroring chainsTo). Stable by
// source position for ties. Returns null on cycles: ambiguous, so the run
// passes through untouched instead of guessing an order.
function orderPrerequisites(run) {
  const n = run.length;
  const successors = run.map(() => new Set());
  const indegree = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j || successors[i].has(j)) continue;
      if (chainsTo(run[i], run[j])) {
        successors[i].add(j);
        indegree[j] += 1;
      }
    }
  }
  const order = [];
  let ready = [];
  for (let i = 0; i < n; i += 1) {
    if (indegree[i] === 0) ready.push(i);
  }
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const i = ready.shift();
    order.push(i);
    for (const j of successors[i]) {
      indegree[j] -= 1;
      if (indegree[j] === 0) ready.push(j);
    }
  }
  if (order.length !== n) return null;
  return order.map((i) => run[i]);
}

// A standalone `=` (assignment) as opposed to `==`, `!=`, `<=`, `>=`.
function standaloneEqualsAt(s, i) {
  if (s[i] !== '=') return false;
  const prev = s[i - 1] ?? '';
  const next = s[i + 1] ?? '';
  return prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>'
    && next !== '=' && next !== '>';
}

function hasStandaloneAssignment(text) {
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    if (standaloneEqualsAt(s, i)) return true;
  }
  return false;
}

// Output identifiers of an expression: the target of every top-level
// `;`-separated assignment segment, in source order. Within-step
// definitions never count as step inputs (mirroring the model's own
// assignment parsing), so multi-statement steps never warn on their own
// intermediates as unresolved references.
function expressionOutputs(text) {
  const defined = [];
  for (const raw of splitTopLevelLocal(String(text ?? ''), ';')) {
    const split = splitAssignmentSegment(raw);
    if (split) defined.push(split.output);
  }
  return defined;
}

function splitTopLevelLocal(text, delimiter) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text ?? '')) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function isInternalReference(members, target) {
  const name = String(target ?? '').trim();
  if (!name) return false;
  if (resolveRoutineReference(members, name)) return true;
  const lower = name.toLowerCase();
  return members.some((m) =>
    String(m?.id ?? '').trim().toLowerCase() === lower
    || String(m?.name ?? '').trim().toLowerCase() === lower);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values ?? []) {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// Merge one run of single-expression members into a multi-step routine.
// sourceOrder is extraction order (identity, metadata, and routine-level
// I/O derive here); stepOrder is execution order with one sequence number
// per member. Shared by both grouping passes.
function buildMergedRoutine({ sourceOrder, stepOrder, sequences, name, id }) {
  const members = sourceOrder;
  const memberOutputs = keySet(members.flatMap((m) => m?.outputs ?? []));
  const memberInputs = keySet(members.flatMap((m) => m?.inputs ?? []));
  const steps = [];
  const stepsDetailed = [];
  stepOrder.forEach((m, idx) => {
    const expression = String(m?.expression_text ?? '').trim();
    steps.push(expression);
    const det = {
      sequence: sequences[idx],
      instruction: expression,
      source_pages: [...(m?.source_pages ?? [])],
      evidence: String(m?.evidence_text ?? ''),
    };
    if (String(m?.source_location ?? '')) det.source_location = String(m.source_location);
    const definedHere = new Set(expressionOutputs(expression).map((o) => normalizeVariableKey(o)));
    if (hasStandaloneAssignment(expression)) {
      det.operation = 'assignment';
      det.expression = expression;
      const outputs = expressionOutputs(expression);
      if (outputs.length > 0) det.output = outputs[outputs.length - 1];
    }
    const inputs = uniqueStrings(m?.inputs ?? [])
      .filter((v) => !definedHere.has(normalizeVariableKey(v)));
    if (inputs.length > 0) det.inputs = inputs;
    const external = uniqueStrings([
      ...(m?.depends_on ?? []),
      ...(m?.dependencies ?? []).map((d) => d?.target),
    ]).filter((dep) => !isInternalReference(members, dep));
    if (external.length > 0) det.depends_on = external;
    stepsDetailed.push(det);
  });
  const externalDepends = uniqueStrings(members.flatMap((m) => [
    ...(m?.depends_on ?? []),
    ...(m?.dependencies ?? []).map((d) => d?.target),
  ])).filter((dep) => !isInternalReference(members, dep));
  return {
    id: id ?? null,
    name: String(name ?? ''),
    kind: 'calculation_steps',
    source_pages: [...new Set(members.flatMap((m) => m?.source_pages ?? []))].sort((a, b) => a - b),
    source_type: members.map((m) => String(m?.source_type ?? '')).find((s) => s) ?? '',
    source_location: members.map((m) => String(m?.source_location ?? '')).find((s) => s) ?? '',
    evidence_text: stepOrder.map((m, idx) => `Step ${sequences[idx]}: ${String(m?.evidence_text ?? '').trim()}`).join('\n'),
    expression_text: '',
    conditions: members.flatMap((m) => m?.conditions ?? []),
    conditions_detailed: members.flatMap((m) => m?.conditions_detailed ?? []),
    steps,
    steps_detailed: stepsDetailed,
    depends_on: externalDepends,
    dependencies: members
      .flatMap((m) => m?.dependencies ?? [])
      .filter((d) => !isInternalReference(members, d?.target)),
    inputs: uniqueStrings(members.flatMap((m) => m?.inputs ?? []))
      .filter((v) => !memberOutputs.has(normalizeVariableKey(v))),
    outputs: uniqueStrings(members.flatMap((m) => m?.outputs ?? []))
      .filter((v) => !memberInputs.has(normalizeVariableKey(v))),
    purpose: uniqueStrings(members.map((m) => m?.purpose)).join('; '),
    applicability: uniqueStrings(members.map((m) => m?.applicability)).join('; '),
    execution_context: uniqueStrings(members.map((m) => m?.execution_context)).join('; '),
    notes: uniqueStrings(members.map((m) => m?.notes)).join('\n'),
    review_status: members.map((m) => String(m?.review_status ?? '')).find((s) => s) ?? '',
    confidence: members.map((m) => m?.confidence).find((c) => c !== undefined && c !== null) ?? null,
  };
}

function buildGroupedRoutine(members) {
  const first = members[0];
  const last = members[members.length - 1];
  const head = parseStepName(first?.name);
  const tail = parseStepName(last?.name);
  const headLabel = `${head.stem}${head.separator}${head.numText}`;
  const tailLabel = `${tail.stem}${tail.separator}${tail.numText}`;
  return buildMergedRoutine({
    sourceOrder: members,
    stepOrder: members,
    sequences: members.map((m) => parseStepName(m?.name).num),
    name: `${headLabel} to ${tailLabel}`,
    id: first?.id ?? null,
  });
}

// The prerequisite run folds under its parent: the source-order-first
// member (topmost consumer) keeps its id and name, with every member's
// formula ordered producer-first underneath it.
function buildPrerequisiteRoutine(sourceOrder, stepOrder) {
  return buildMergedRoutine({
    sourceOrder,
    stepOrder,
    sequences: stepOrder.map((_, idx) => idx + 1),
    name: String(sourceOrder[0]?.name ?? ''),
    id: sourceOrder[0]?.id ?? null,
  });
}

function groupNumberedChains(list) {
  const out = [];
  const groupings = [];
  let i = 0;
  while (i < list.length) {
    const run = [list[i]];
    let j = i;
    while (j + 1 < list.length && extendsRun(run, list[j + 1])) {
      run.push(list[j + 1]);
      j += 1;
    }
    if (run.length >= 2) {
      const grouped = buildGroupedRoutine(run);
      out.push(grouped);
      groupings.push({
        routineId: grouped.id,
        routineName: grouped.name,
        memberIds: run.map((m) => m?.id ?? ''),
        memberNames: run.map((m) => String(m?.name ?? '')),
        stepNumbers: run.map((m) => parseStepName(m?.name).num),
        sourcePages: [...grouped.source_pages],
        reason: 'numbered_chain',
      });
    } else {
      out.push(list[i]);
    }
    i = j + 1;
  }
  return { routines: out, groupings };
}

function groupPrerequisiteChains(list) {
  const out = [];
  const groupings = [];
  let i = 0;
  while (i < list.length) {
    const run = [list[i]];
    let j = i;
    while (j + 1 < list.length && extendsPrerequisiteRun(run, list[j + 1])) {
      run.push(list[j + 1]);
      j += 1;
    }
    if (run.length >= 2) {
      const ordered = orderPrerequisites(run);
      if (ordered) {
        const grouped = buildPrerequisiteRoutine(run, ordered);
        out.push(grouped);
        groupings.push({
          routineId: grouped.id,
          routineName: grouped.name,
          memberIds: run.map((m) => m?.id ?? ''),
          memberNames: run.map((m) => String(m?.name ?? '')),
          stepNumbers: ordered.map((_, idx) => idx + 1),
          sourcePages: [...grouped.source_pages],
          reason: 'prerequisite',
          links: run.slice(0, -1).map((first, k) => ({
            consumer: String(first?.name ?? ''),
            producer: String(run[k + 1]?.name ?? ''),
            variables: linkVariables(first, run[k + 1]),
            viaNaming: namesAsDependency(first, run[k + 1]),
          })),
        });
      } else {
        out.push(...run);
      }
    } else {
      out.push(list[i]);
    }
    i = j + 1;
  }
  return { routines: out, groupings };
}

/**
 * Group adjacent single-expression routines into multi-step routines.
 * Numbered chains merge first, then prerequisite chains over the result.
 * Returns { routines, groupings }; groupings documents each merge for the
 * caller's verification warning.
 */
export function groupStepRoutines(routines) {
  const list = Array.isArray(routines) ? routines : [];
  const numbered = groupNumberedChains(list);
  const prerequisite = groupPrerequisiteChains(numbered.routines);
  return { routines: prerequisite.routines, groupings: [...numbered.groupings, ...prerequisite.groupings] };
}
