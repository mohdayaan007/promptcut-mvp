import path from "path";
import { readFile, stat, unlink } from "fs/promises";
import { runReferenceVideoProcess } from "@/lib/editor-core/reference-video-foundation";
import { EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";

export const REFERENCE_VIDEO_EVIDENCE_VERSION = 1;
export const REFERENCE_VIDEO_OBSERVATIONS_VERSION = 1;
export const REFERENCE_VIDEO_CREATIVE_SIGNATURE_VERSION = 1;
export const RV1_MAX_SCENE_BOUNDARIES = 12;
export const RV1_MAX_REPRESENTATIVE_FRAMES = 18;
export const RV1_FRAME_WIDTH = 320;
export const RV1_DETAIL_FRAME_WIDTH = 640;
export const RV1_MAX_DETAIL_FRAMES = 4;
export const RV1_MAX_FRAME_BYTES = 350 * 1024;
export const RV1_MAX_VISUAL_REQUEST_BYTES = 3 * 1024 * 1024;
export const RV1_SCENE_SCAN_TIMEOUT_MS = 12_000;
export const RV1_EVENT_SCAN_TIMEOUT_MS = 8_000;
export const RV1_FRAME_TIMEOUT_MS = 4_000;
export const RV1_MAX_MODEL_RESPONSE_BYTES = 64 * 1024;
export const RV1_MAX_INTERPRETER_CALLS = 1;
export const RV1_INTERPRETER_TIMEOUT_MS = 10_000;

const PALETTES = ["unknown", "neutral", "warm", "cool", "mixed"];
const LEVELS = ["unknown", "low", "medium", "high"];
const TYPE_STATES = ["unknown", "absent", "present", "ambiguous"];
const TYPE_ROLES = ["unknown", "creative_title", "supporting_text", "subtitle", "environmental", "interface"];
const TRANSITIONS = ["unknown", "hard_cut", "gradual"];
const PACING = ["unknown", "slow", "medium", "fast"];
const EPSILON = 0.001;

export class ReferenceVideoObservationError extends Error {
  constructor(reason, message = "Reference-video evidence could not be interpreted safely.") {
    super(message); this.name = "ReferenceVideoObservationError"; this.reason = reason;
  }
}
function exactObject(value, fields, field) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE", `Invalid ${field}`); for (const key of Object.keys(value)) if (!fields.includes(key)) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE", `Invalid ${field}.${key}`); return value; }
function enumValue(value, values, field) { if (!values.includes(value)) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE", `Invalid ${field}`); return value; }
function time(value, duration, field) { if (!Number.isFinite(value) || value < 0 || value > duration) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE", `Invalid ${field}`); return value; }
function unique(values) { return [...new Set(values)]; }
function rounded(value) { return Number(value.toFixed(3)); }
function throwIfAborted(signal, controller) { if (signal?.aborted || controller?.isCancelled?.()) throw new EditExecutionCancelledError(); }
function parseSceneTimestamps(stderr, duration) { return unique([...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value > 0.001 && value < duration - 0.001).map(rounded)).sort((a, b) => a - b); }
function shotForTimestamp(shots, timestamp) { return shots.find((shot, index) => timestamp >= shot.start - EPSILON && (timestamp < shot.end - EPSILON || (index === shots.length - 1 && timestamp <= shot.end + EPSILON))); }
function boundedTimestamp(value, duration) { return rounded(duration <= 0.1 ? Math.max(0, duration / 2) : Math.max(0.05, Math.min(duration - 0.05, value))); }

/** 4K/1080p inputs stay bounded: only a few title/event candidates receive 640px inspection. */
export function referenceVideoAnalysisFrameWidth(media, { detail = false } = {}) {
  return detail && Math.max(Number(media?.width) || 0, Number(media?.height) || 0) >= 1920 ? RV1_DETAIL_FRAME_WIDTH : RV1_FRAME_WIDTH;
}

/** Deterministic allocation: opening/end, independent shots, events, then coverage anchors. */
export function allocateReferenceVideoFrameTimes({ duration, shots, eventTimestamps = [], budget = RV1_MAX_REPRESENTATIVE_FRAMES }) {
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(shots) || budget < 1) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE");
  const candidates = new Map();
  const add = (value, priority) => { const timestamp = boundedTimestamp(value, duration); const previous = candidates.get(timestamp); if (!previous || priority < previous.priority) candidates.set(timestamp, { timestamp, priority }); };
  add(0, 0); add(duration, 0);
  const indexes = shots.length <= budget ? shots.map((_, index) => index) : Array.from({ length: budget }, (_, index) => Math.round(index * (shots.length - 1) / Math.max(1, budget - 1)));
  for (const index of unique(indexes)) add((shots[index].start + shots[index].end) / 2, 1);
  for (const event of eventTimestamps) add(event, 2);
  for (const fraction of [0.15, 0.35, 0.5, 0.65, 0.85]) add(duration * fraction, 3);
  const timestamps = [...candidates.values()].sort((a, b) => a.priority - b.priority || a.timestamp - b.timestamp).slice(0, budget).map((entry) => entry.timestamp).sort((a, b) => a - b);
  const represented = new Set(timestamps.map((entry) => shotForTimestamp(shots, entry)?.shotId).filter(Boolean));
  return Object.freeze({ timestamps: Object.freeze(timestamps), unrepresentedShotIds: Object.freeze(shots.filter((shot) => !represented.has(shot.shotId)).map((shot) => shot.shotId)) });
}
async function removeFiles(paths, remove = unlink) { await Promise.all(paths.map((file) => remove(file).catch(() => {}))); }
async function assertReadableJpeg(filePath, { read = readFile, fileStat = stat } = {}) { const details = await fileStat(filePath); const bytes = await read(filePath); if (!details?.size || details.size > RV1_MAX_FRAME_BYTES || bytes.length < 4 || bytes.length > RV1_MAX_FRAME_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new ReferenceVideoObservationError("RV1_CORRUPT_FRAME"); return bytes; }

/** Extracts bounded server-owned temporal evidence. Returned scratch JPEGs belong to the caller on success. */
export async function extractReferenceVideoTemporalEvidence({ inputPath, media, scratchDirectory, executionController, run = runReferenceVideoProcess, read = readFile, fileStat = stat, remove = unlink, nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }) {
  const duration = Number(media?.duration); if (!Number.isFinite(duration) || duration <= 0 || !scratchDirectory) throw new ReferenceVideoObservationError("RV1_INVALID_INPUT");
  const framePaths = [];
  try {
    throwIfAborted(null, executionController);
    const sceneResult = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", inputPath, "-vf", "select='gt(scene,0.28)',showinfo", "-an", "-frames:v", String(RV1_MAX_SCENE_BOUNDARIES), "-f", "null", "-"], { executionController, timeoutMs: RV1_SCENE_SCAN_TIMEOUT_MS });
    const hardCutTimestamps = parseSceneTimestamps(sceneResult.stderr, duration).slice(0, RV1_MAX_SCENE_BOUNDARIES);
    let visualChangeTimestamps = []; let eventScanComplete = true; const eventWindows = [];
    // Four bounded temporal windows prevent early motion from consuming all event evidence.
    for (let bucket = 0; bucket < 4; bucket += 1) {
      const start = rounded(Math.max(0, duration * bucket / 4 - 0.1)); const end = rounded(Math.min(duration, duration * (bucket + 1) / 4 + 0.1));
      try {
        const events = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", inputPath, "-vf", `trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=64:-2,select='gt(scene,0.001)',showinfo`, "-an", "-frames:v", "2", "-f", "null", "-"], { executionController, timeoutMs: RV1_EVENT_SCAN_TIMEOUT_MS });
        const candidates = parseSceneTimestamps(events.stderr, end - start).map((timestamp) => rounded(timestamp + start));
        visualChangeTimestamps.push(...candidates);
        eventWindows.push({ start, end, candidateCount: candidates.length, saturated: candidates.length >= 2, available: true });
      } catch (error) { if (error instanceof EditExecutionCancelledError || executionController?.isCancelled()) throw error; eventScanComplete = false; eventWindows.push({ start, end, candidateCount: 0, saturated: false, available: false }); }
    }
    visualChangeTimestamps = unique(visualChangeTimestamps).filter((timestamp) => !hardCutTimestamps.some((cut) => Math.abs(cut - timestamp) < 0.15));
    const edges = [0, ...hardCutTimestamps, duration]; const shots = edges.slice(0, -1).map((start, index) => Object.freeze({ shotId: `shot-${index + 1}`, start: rounded(start), end: rounded(edges[index + 1]) }));
    const allocation = allocateReferenceVideoFrameTimes({ duration, shots, eventTimestamps: visualChangeTimestamps }); const frames = [];
    const detailTimes = new Set(visualChangeTimestamps.slice(0, RV1_MAX_DETAIL_FRAMES));
    for (const [index, timestamp] of allocation.timestamps.entries()) { throwIfAborted(null, executionController); const imagePath = path.join(scratchDirectory, `rv1-reference-${nonce}-${index + 1}.jpg`); framePaths.push(imagePath); const width = referenceVideoAnalysisFrameWidth(media, { detail: detailTimes.has(timestamp) }); await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(timestamp), "-i", inputPath, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", imagePath], { executionController, timeoutMs: RV1_FRAME_TIMEOUT_MS }); await assertReadableJpeg(imagePath, { read, fileStat }); const shot = shotForTimestamp(shots, timestamp); if (!shot) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE"); frames.push(Object.freeze({ frameId: `frame-${index + 1}`, shotId: shot.shotId, timestamp, imagePath })); }
    const eventCoverageComplete = eventScanComplete && !eventWindows.some((entry) => entry.saturated);
    const complete = eventCoverageComplete && hardCutTimestamps.length < RV1_MAX_SCENE_BOUNDARIES && allocation.unrepresentedShotIds.length === 0;
    const reason = !eventScanComplete ? "event_scan_unavailable" : !eventCoverageComplete ? "event_window_budget_reached" : hardCutTimestamps.length >= RV1_MAX_SCENE_BOUNDARIES ? "scene_boundary_budget_reached" : allocation.unrepresentedShotIds.length ? "frame_budget_unrepresented_shots" : "bounded_temporal_sampling";
    return validateReferenceVideoEvidence({ version: 1, duration, coverage: { complete, reason, unrepresentedShotIds: allocation.unrepresentedShotIds, eventWindows }, shots, frames, events: [...hardCutTimestamps.map((timestamp, index) => ({ eventId: `cut-${index + 1}`, timestamp, kind: "hard_cut" })), ...visualChangeTimestamps.map((timestamp, index) => ({ eventId: `event-${index + 1}`, timestamp, kind: "visual_change" }))] });
  } catch (error) { await removeFiles(framePaths, remove); if (error instanceof EditExecutionCancelledError || executionController?.isCancelled()) throw new EditExecutionCancelledError(); if (error instanceof ReferenceVideoObservationError) throw error; throw new ReferenceVideoObservationError(error?.reason === "REFERENCE_VIDEO_TIMEOUT" ? "RV1_EXTRACTION_TIMEOUT" : "RV1_EXTRACTION_FAILED"); }
}

export function validateReferenceVideoEvidence(value) {
  const root = exactObject(value, ["version", "duration", "coverage", "shots", "frames", "events"], "evidence");
  if (root.version !== 1 || !Number.isFinite(root.duration) || root.duration <= 0 || !Array.isArray(root.shots) || !root.shots.length || root.shots.length > RV1_MAX_SCENE_BOUNDARIES + 1 || !Array.isArray(root.frames) || !root.frames.length || root.frames.length > RV1_MAX_REPRESENTATIVE_FRAMES || !Array.isArray(root.events) || root.events.length > RV1_MAX_SCENE_BOUNDARIES + 8) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE");
  const coverage = exactObject(root.coverage, ["complete", "reason", "unrepresentedShotIds", "eventWindows"], "coverage"); if (typeof coverage.complete !== "boolean" || typeof coverage.reason !== "string" || !Array.isArray(coverage.unrepresentedShotIds) || (coverage.eventWindows !== undefined && !Array.isArray(coverage.eventWindows))) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE");
  const ids = new Set(); let end = 0; const shots = root.shots.map((raw, index) => { const shot = exactObject(raw, ["shotId", "start", "end"], "shot"); if (typeof shot.shotId !== "string" || !shot.shotId || ids.has(shot.shotId) || !Number.isFinite(shot.start) || !Number.isFinite(shot.end) || shot.start < 0 || shot.end <= shot.start || Math.abs(shot.start - end) > EPSILON || shot.end > root.duration + EPSILON || (index === 0 && shot.start > EPSILON)) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE"); ids.add(shot.shotId); end = shot.end; return Object.freeze({ ...shot }); });
  if (Math.abs(shots.at(-1).end - root.duration) > EPSILON || unique(coverage.unrepresentedShotIds).length !== coverage.unrepresentedShotIds.length || coverage.unrepresentedShotIds.some((id) => !ids.has(id)) || (coverage.complete && coverage.unrepresentedShotIds.length)) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE");
  const frameIds = new Set(); const frames = root.frames.map((raw) => { const frame = exactObject(raw, ["frameId", "shotId", "timestamp", "imagePath"], "frame"); const owner = shotForTimestamp(shots, frame.timestamp); if (typeof frame.frameId !== "string" || !frame.frameId || frameIds.has(frame.frameId) || typeof frame.imagePath !== "string" || !frame.imagePath || !ids.has(frame.shotId) || !Number.isFinite(frame.timestamp) || owner?.shotId !== frame.shotId) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE"); frameIds.add(frame.frameId); return Object.freeze({ ...frame }); });
  const eventIds = new Set(); const events = root.events.map((raw) => { const event = exactObject(raw, ["eventId", "timestamp", "kind"], "event"); if (typeof event.eventId !== "string" || !event.eventId || eventIds.has(event.eventId) || !Number.isFinite(event.timestamp) || event.timestamp < 0 || event.timestamp > root.duration || !["hard_cut", "visual_change"].includes(event.kind) || (event.kind === "hard_cut" && !shots.slice(1).some((shot) => Math.abs(shot.start - event.timestamp) < 0.15))) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE"); eventIds.add(event.eventId); return Object.freeze({ ...event }); });
  const eventWindows = (coverage.eventWindows || []).map((raw) => { const window = exactObject(raw, ["start", "end", "candidateCount", "saturated", "available"], "eventWindow"); if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start < 0 || window.end <= window.start || window.end > root.duration || !Number.isInteger(window.candidateCount) || window.candidateCount < 0 || window.candidateCount > 2 || typeof window.saturated !== "boolean" || typeof window.available !== "boolean" || (window.saturated && window.candidateCount < 2)) throw new ReferenceVideoObservationError("RV1_INVALID_EVIDENCE"); return Object.freeze({ ...window }); });
  return Object.freeze({ version: root.version, duration: root.duration, coverage: Object.freeze({ complete: coverage.complete, reason: coverage.reason, unrepresentedShotIds: Object.freeze([...coverage.unrepresentedShotIds]), eventWindows: Object.freeze(eventWindows) }), shots: Object.freeze(shots), frames: Object.freeze(frames), events: Object.freeze(events) });
}
function knownEvidence(evidence) { const normalized = validateReferenceVideoEvidence(evidence); return { evidence: normalized, shotById: new Map(normalized.shots.map((shot) => [shot.shotId, shot])), frameById: new Map(normalized.frames.map((frame) => [frame.frameId, frame])) }; }

export function validateReferenceVideoObservations(value, evidence) {
  const known = knownEvidence(evidence); const root = exactObject(value, ["version", "observations"], "observations"); if (root.version !== 1 || !Array.isArray(root.observations) || root.observations.length > known.evidence.frames.length) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE");
  const ids = new Set(); const occupied = new Map();
  const observations = root.observations.map((raw) => {
    const entry = exactObject(raw, ["observationId", "shotId", "frameIds", "start", "end", "photographic", "typography", "composition", "rhythm", "transition"], "observation"); const shot = known.shotById.get(entry.shotId);
    if (typeof entry.observationId !== "string" || !entry.observationId || ids.has(entry.observationId) || !shot || !Array.isArray(entry.frameIds) || !entry.frameIds.length) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE"); ids.add(entry.observationId);
    const frameIds = unique(entry.frameIds); const start = time(entry.start, known.evidence.duration, "observation.start"); const finish = time(entry.end, known.evidence.duration, "observation.end");
    if (finish <= start || start < shot.start - EPSILON || finish > shot.end + EPSILON || frameIds.some((id) => !known.frameById.has(id) || known.frameById.get(id).shotId !== shot.shotId || known.frameById.get(id).timestamp < start - EPSILON || known.frameById.get(id).timestamp > finish + EPSILON)) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE");
    const ranges = occupied.get(shot.shotId) || []; if (ranges.some((range) => start < range.end - EPSILON && finish > range.start + EPSILON)) throw new ReferenceVideoObservationError("RV1_INVALID_RESPONSE"); ranges.push({ start, end: finish }); occupied.set(shot.shotId, ranges);
    const photographic = exactObject(entry.photographic, ["palette", "exposure", "contrast", "saturation", "texture"], "photographic"); const typography = exactObject(entry.typography, ["state", "role", "prominence", "fontCharacter", "weight", "position", "alignment", "colorCharacter"], "typography"); const composition = exactObject(entry.composition, ["framing", "balance", "titleSafeArea", "subjectPlacement", "negativeSpace"], "composition"); const rhythm = exactObject(entry.rhythm, ["pacing"], "rhythm"); const transition = exactObject(entry.transition, ["type"], "transition");
    return Object.freeze({ observationId: entry.observationId, shotId: entry.shotId, frameIds: Object.freeze(frameIds), start, end: finish, photographic: Object.freeze({ palette: enumValue(photographic.palette, PALETTES, "photographic.palette"), exposure: enumValue(photographic.exposure, LEVELS, "photographic.exposure"), contrast: enumValue(photographic.contrast, LEVELS, "photographic.contrast"), saturation: enumValue(photographic.saturation, LEVELS, "photographic.saturation"), texture: enumValue(photographic.texture, ["unknown", "clean", "soft", "grain"], "photographic.texture") }), typography: Object.freeze({ state: enumValue(typography.state, TYPE_STATES, "typography.state"), role: enumValue(typography.role, TYPE_ROLES, "typography.role"), prominence: enumValue(typography.prominence, LEVELS, "typography.prominence"), fontCharacter: enumValue(typography.fontCharacter, ["unknown", "serif", "sans", "display", "handwritten"], "typography.fontCharacter"), weight: enumValue(typography.weight, ["unknown", "light", "regular", "bold"], "typography.weight"), position: enumValue(typography.position, ["unknown", "top", "center", "bottom", "corner"], "typography.position"), alignment: enumValue(typography.alignment, ["unknown", "left", "center", "right"], "typography.alignment"), colorCharacter: enumValue(typography.colorCharacter, ["unknown", "light", "dark", "warm", "cool", "mixed"], "typography.colorCharacter") }), composition: Object.freeze({ framing: enumValue(composition.framing, ["unknown", "wide", "medium", "close"], "composition.framing"), balance: enumValue(composition.balance, ["unknown", "symmetric", "asymmetric", "centered"], "composition.balance"), titleSafeArea: enumValue(composition.titleSafeArea, ["unknown", "none", "top", "center", "bottom"], "composition.titleSafeArea"), subjectPlacement: enumValue(composition.subjectPlacement, ["unknown", "left", "center", "right", "multiple"], "composition.subjectPlacement"), negativeSpace: enumValue(composition.negativeSpace, LEVELS, "composition.negativeSpace") }), rhythm: Object.freeze({ pacing: enumValue(rhythm.pacing, PACING, "rhythm.pacing") }), transition: Object.freeze({ type: enumValue(transition.type, TRANSITIONS, "transition.type") }) });
  });
  return Object.freeze({ version: 1, observations: Object.freeze(observations) });
}

/** Reads private JPEGs into bounded model-facing evidence; paths are never supplied to the adapter. */
export async function buildReferenceVideoVisualEvidence({ evidence, signal, read = readFile, fileStat = stat }) {
  const normalized = validateReferenceVideoEvidence(evidence); let total = 0; const frames = [];
  for (const frame of normalized.frames) { throwIfAborted(signal); const bytes = await assertReadableJpeg(frame.imagePath, { read, fileStat }); throwIfAborted(signal); total += bytes.length; if (total > RV1_MAX_VISUAL_REQUEST_BYTES) throw new ReferenceVideoObservationError("RV1_VISUAL_REQUEST_TOO_LARGE"); frames.push(Object.freeze({ frameId: frame.frameId, shotId: frame.shotId, timestamp: frame.timestamp, mimeType: "image/jpeg", bytes })); }
  return Object.freeze(frames);
}
/** Internal-only, injectable adapter. The caller is bounded to one abortable request. */
export async function interpretReferenceVideoEvidence({ evidence, interpret, signal, loadVisualEvidence = buildReferenceVideoVisualEvidence, timeoutMs = RV1_INTERPRETER_TIMEOUT_MS }) {
  if (typeof interpret !== "function" || typeof loadVisualEvidence !== "function") throw new ReferenceVideoObservationError("RV1_INTERPRETER_UNAVAILABLE");
  if (signal?.aborted) throw new ReferenceVideoObservationError("RV1_INTERPRETER_CANCELLED");
  const normalized = validateReferenceVideoEvidence(evidence); const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); const timeout = setTimeout(abort, timeoutMs);
  const deadline = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new ReferenceVideoObservationError(signal?.aborted ? "RV1_INTERPRETER_CANCELLED" : "RV1_INTERPRETER_TIMEOUT")), { once: true }));
  const operation = async () => { const frames = await loadVisualEvidence({ evidence: normalized, signal: controller.signal }); throwIfAborted(controller.signal); const response = await interpret({ version: normalized.version, shots: normalized.shots.map(({ shotId, start, end }) => ({ shotId, start, end })), frames, signal: controller.signal, callBudget: RV1_MAX_INTERPRETER_CALLS }); throwIfAborted(controller.signal); if (Buffer.byteLength(JSON.stringify(response || {})) > RV1_MAX_MODEL_RESPONSE_BYTES) throw new ReferenceVideoObservationError("RV1_RESPONSE_TOO_LARGE"); return validateReferenceVideoObservations(response, normalized); };
  try { return await Promise.race([operation(), deadline]); } catch (error) { if (error instanceof ReferenceVideoObservationError) throw error; if (error instanceof EditExecutionCancelledError || controller.signal.aborted || signal?.aborted) throw new ReferenceVideoObservationError("RV1_INTERPRETER_CANCELLED"); throw new ReferenceVideoObservationError("RV1_INTERPRETER_FAILED"); } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
function unionDuration(intervals) { const sorted = [...intervals].sort((a, b) => a.start - b.start); let total = 0; let open; for (const interval of sorted) { if (!open || interval.start > open.end + EPSILON) { if (open) total += open.end - open.start; open = { ...interval }; } else open.end = Math.max(open.end, interval.end); } return total + (open ? open.end - open.start : 0); }
function supportFor(observations, selector, value, duration) { const matches = observations.filter((entry) => selector(entry) === value); return { observations: matches, observationIds: unique(matches.map((entry) => entry.observationId)), shotIds: unique(matches.map((entry) => entry.shotId)), frameIds: unique(matches.flatMap((entry) => entry.frameIds)), coverage: rounded(Math.min(1, unionDuration(matches) / duration)) }; }
function derivePacing(shot) { const duration = shot.end - shot.start; return duration < 1.5 ? "fast" : duration > 4 ? "slow" : "medium"; }
function typographyKey(entry) { return [entry.fontCharacter, entry.weight, entry.prominence, entry.position, entry.alignment, entry.colorCharacter].join("|"); }

/** Conservative server aggregation. This remains evidence, never an executable edit plan. */
export function aggregateReferenceVideoCreativeSignature({ evidence, observations }) {
  const known = knownEvidence(evidence); const normalized = validateReferenceVideoObservations(observations, known.evidence); const duration = known.evidence.duration; const observedCoverage = rounded(unionDuration(normalized.observations) / duration); const persistent = []; const characteristics = [];
  for (const field of ["palette", "exposure", "contrast", "saturation", "texture"]) {
    const values = unique(normalized.observations.map((entry) => entry.photographic[field]).filter((value) => value !== "unknown"));
    for (const value of values) {
      const support = supportFor(normalized.observations, (entry) => entry.photographic[field], value, duration);
      const independent = known.evidence.shots.length > 1 ? support.shotIds.length >= 2 : support.frameIds.length >= 2;
      const state = support.coverage >= 0.55 && independent ? "persistent" : support.observationIds.length ? "provisional" : "unknown";
      const record = Object.freeze({ field, value, [field]: value, state, observationIds: Object.freeze(support.observationIds), frameIds: Object.freeze(support.frameIds), shotIds: Object.freeze(support.shotIds), sampledFrameCount: support.frameIds.length, coverage: support.coverage, observedCoverage: observedCoverage ? rounded(support.coverage / observedCoverage) : 0 });
      characteristics.push(record);
      if (field === "palette" && state === "persistent") persistent.push(record);
    }
  }
  const sceneSpecific = normalized.observations.filter((entry) => entry.photographic.palette !== "unknown" && !persistent.some((item) => item.palette === entry.photographic.palette)).map((entry) => Object.freeze({ observationId: entry.observationId, shotId: entry.shotId, palette: entry.photographic.palette, start: entry.start, end: entry.end }));
  const titles = normalized.observations.filter((entry) => entry.typography.state === "present" && entry.typography.role === "creative_title").map((entry) => Object.freeze({ observationId: entry.observationId, start: entry.start, end: entry.end, prominence: entry.typography.prominence, fontCharacter: entry.typography.fontCharacter, weight: entry.typography.weight, position: entry.typography.position, alignment: entry.typography.alignment, colorCharacter: entry.typography.colorCharacter }));
  const openingLimit = Math.min(2, duration * 0.2); const closingLimit = duration - Math.min(2, duration * 0.2);
  const sustained = titles.filter((entry) => entry.start <= openingLimit && entry.end >= closingLimit);
  const recurringKeys = new Set([...new Set(titles.map(typographyKey))].filter((key) => { const matches = titles.filter((entry) => typographyKey(entry) === key); return matches.length >= 2 && (unique(matches.map((entry) => entry.start)).length >= 2 || unique(matches.map((entry) => entry.observationId)).length >= 2); }));
  const recurring = titles.filter((entry) => !sustained.includes(entry) && recurringKeys.has(typographyKey(entry)));
  const opening = titles.filter((entry) => !sustained.includes(entry) && !recurring.includes(entry) && entry.start <= openingLimit);
  const closing = titles.filter((entry) => !sustained.includes(entry) && !recurring.includes(entry) && !opening.includes(entry) && entry.end >= closingLimit);
  const sceneTypography = titles.filter((entry) => !sustained.includes(entry) && !recurring.includes(entry) && !opening.includes(entry) && !closing.includes(entry));
  const composition = ["framing", "balance", "titleSafeArea", "subjectPlacement", "negativeSpace"].map((field) => {
    const knownValues = unique(normalized.observations.map((entry) => entry.composition[field]).filter((value) => value !== "unknown"));
    const recurringPatterns = knownValues.map((value) => supportFor(normalized.observations, (entry) => entry.composition[field], value, duration)).filter((support) => support.observationIds.length >= 2 && support.shotIds.length >= (known.evidence.shots.length > 1 ? 2 : 1)).map((support) => Object.freeze({ value: normalized.observations.find((entry) => support.observationIds.includes(entry.observationId)).composition[field], observationIds: Object.freeze(support.observationIds), shotIds: Object.freeze(support.shotIds), coverage: support.coverage }));
    const recurringIds = new Set(recurringPatterns.flatMap((entry) => entry.observationIds));
    return Object.freeze({ field, recurring: Object.freeze(recurringPatterns), sceneSpecific: Object.freeze(normalized.observations.filter((entry) => entry.composition[field] !== "unknown" && !recurringIds.has(entry.observationId)).map((entry) => Object.freeze({ observationId: entry.observationId, shotId: entry.shotId, value: entry.composition[field] }))) });
  });
  const transitions = normalized.observations.map((entry) => { const shot = known.shotById.get(entry.shotId); const hasBoundaryEvidence = shot.start > EPSILON && known.evidence.events.some((event) => event.kind === "hard_cut" && Math.abs(event.timestamp - shot.start) < 0.2); return Object.freeze({ shotId: entry.shotId, type: entry.transition.type === "hard_cut" && hasBoundaryEvidence ? "hard_cut" : "unknown" }); });
  const conflicts = characteristics.filter((entry) => entry.state === "persistent").reduce((list, entry) => list.includes(entry.field) ? list : [...list, entry.field], []).filter((field) => characteristics.filter((entry) => entry.field === field && entry.state === "persistent").length > 1).map((field) => `persistent_${field}_conflict`);
  return Object.freeze({ version: 1, evidenceVersion: known.evidence.version, confidence: Object.freeze({ completeEvidence: Boolean(known.evidence.coverage.complete), eventCoverageComplete: known.evidence.coverage.eventWindows.every((entry) => entry.available && !entry.saturated), observedCoverage, incompleteObservationCoverage: observedCoverage < 0.75, observationCount: normalized.observations.length, conflicts: Object.freeze(conflicts) }), photographic: Object.freeze({ persistent: Object.freeze(persistent), characteristics: Object.freeze(characteristics), provisional: Object.freeze(characteristics.filter((entry) => entry.state === "provisional")), sceneSpecific: Object.freeze(sceneSpecific) }), typography: Object.freeze({ opening: Object.freeze(opening), closing: Object.freeze(closing), sustained: Object.freeze(sustained), recurring: Object.freeze(recurring), sceneSpecific: Object.freeze(sceneTypography) }), composition: Object.freeze(composition), rhythm: Object.freeze({ segments: Object.freeze(known.evidence.shots.map((shot) => Object.freeze({ shotId: shot.shotId, start: shot.start, end: shot.end, duration: rounded(shot.end - shot.start), pacing: derivePacing(shot) }))) }), transitions: Object.freeze(transitions) });
}
