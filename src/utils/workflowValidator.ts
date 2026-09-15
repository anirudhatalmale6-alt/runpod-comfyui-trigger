/**
 * Pre-submission validation of a ComfyUI workflow graph.
 *
 * Why this exists: a graph that names a model the worker image does not carry is
 * rejected by ComfyUI's own validator — but only AFTER RunPod has spun up the
 * container. A real run of ours spent 22.5s of queue and 2.6s of execution to be
 * told `ckpt_name: 'v1-5-pruned-emaonly.ckpt' not in ['flux1-dev-fp8.safetensors']`.
 * That is a knowable, local, free check, and it was paid for in GPU seconds.
 *
 * So: if the caller tells us which models the endpoint actually has, we check
 * the graph against that list before spending anything.
 *
 * No Trigger.dev import — pure and unit tested.
 */

/** Node input fields that name a model file, keyed by the field name. */
export const MODEL_INPUT_FIELDS = [
  'ckpt_name',
  'unet_name',
  'vae_name',
  'clip_name',
  'clip_name1',
  'clip_name2',
  'lora_name',
  'control_net_name',
  'style_model_name',
  'upscale_model_name',
  'gligen_name',
] as const;

export type ModelInputField = (typeof MODEL_INPUT_FIELDS)[number];

export type ModelRef = {
  nodeId: string;
  classType: string;
  field: ModelInputField;
  value: string;
};

export type WorkflowProblem = {
  nodeId: string;
  classType: string;
  field: string;
  received: string;
  available: string[];
  message: string;
};

/**
 * Available models the endpoint carries, keyed by the input field they satisfy.
 * A field with no entry is not checked — silence means "unknown", never "empty".
 */
export type AvailableModels = Partial<Record<ModelInputField, string[]>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a ComfyUI API-format graph and pull out every model file it names.
 *
 * The API format is `{ "<nodeId>": { class_type, inputs: {...} }, ... }`.
 * Anything that does not look like that is skipped rather than throwing — a
 * validator that crashes on an unfamiliar graph is worse than one that passes.
 */
export function extractModelRefs(workflow: unknown): ModelRef[] {
  if (!isPlainObject(workflow)) return [];

  const refs: ModelRef[] = [];

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!isPlainObject(node)) continue;
    const classType = typeof node.class_type === 'string' ? node.class_type : '(unknown)';
    const inputs = node.inputs;
    if (!isPlainObject(inputs)) continue;

    for (const field of MODEL_INPUT_FIELDS) {
      const value = inputs[field];
      // A node input can be a wire to another node, expressed as [nodeId, slot].
      // Only literal strings name a file.
      if (typeof value === 'string' && value.length > 0) {
        refs.push({ nodeId, classType, field, value });
      }
    }
  }

  return refs;
}

/**
 * Check the graph's model references against what the endpoint actually has.
 *
 * Only fields present in `available` are checked. An absent field means we have
 * not been told, so we say nothing rather than inventing a failure.
 */
export function validateWorkflow(workflow: unknown, available: AvailableModels): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];

  for (const ref of extractModelRefs(workflow)) {
    const allowed = available[ref.field];
    if (!allowed || allowed.length === 0) continue;
    if (allowed.includes(ref.value)) continue;

    problems.push({
      nodeId: ref.nodeId,
      classType: ref.classType,
      field: ref.field,
      received: ref.value,
      available: allowed,
      message:
        `Node ${ref.nodeId} (${ref.classType}): ${ref.field} is "${ref.value}", ` +
        `which this endpoint does not have. Available: ${allowed.join(', ')}.`,
    });
  }

  return problems;
}

/**
 * Pull the available-model list out of ComfyUI's own validation error.
 *
 * The first failure tells you the answer; this turns it into config so the
 * second failure never happens. Recognises the trailing
 * "Available checkpoint models: a.safetensors, b.safetensors" line, and the
 * inline "not in ['a', 'b']" form.
 */
export function extractAvailableFromError(errorText: unknown): string[] {
  const text =
    typeof errorText === 'string' ? errorText : errorText === undefined ? '' : JSON.stringify(errorText);
  if (text === '') return [];

  const trailing = /Available [a-z ]*models:\s*([^"\\\n]+)/i.exec(text);
  if (trailing?.[1]) {
    return trailing[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
  }

  const inline = /not in \[([^\]]*)\]/i.exec(text);
  if (inline?.[1]) {
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
  }

  return [];
}

/**
 * Parse `RUNPOD_AVAILABLE_CHECKPOINTS`-style comma-separated config.
 * Empty or unset yields an empty list, which disables the check for that field.
 */
export function parseModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build the AvailableModels map from environment configuration. */
export function availableModelsFromEnv(env: NodeJS.ProcessEnv = process.env): AvailableModels {
  const out: AvailableModels = {};
  const ckpt = parseModelList(env.RUNPOD_AVAILABLE_CHECKPOINTS);
  if (ckpt.length > 0) out.ckpt_name = ckpt;
  const unet = parseModelList(env.RUNPOD_AVAILABLE_UNETS);
  if (unet.length > 0) out.unet_name = unet;
  const vae = parseModelList(env.RUNPOD_AVAILABLE_VAES);
  if (vae.length > 0) out.vae_name = vae;
  const lora = parseModelList(env.RUNPOD_AVAILABLE_LORAS);
  if (lora.length > 0) out.lora_name = lora;
  return out;
}
