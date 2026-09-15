import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractModelRefs,
  validateWorkflow,
  extractAvailableFromError,
  parseModelList,
  availableModelsFromEnv,
} from '../src/utils/workflowValidator.ts';

/** The graph shape from the client's real failing run. */
const SD15_GRAPH = {
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.ckpt' },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a cat', clip: ['4', 1] },
  },
  '9': {
    class_type: 'SaveImage',
    inputs: { images: ['8', 0] },
  },
};

/** The exact error text the live endpoint returned. */
const LIVE_ERROR =
  "Workflow validation failed:\n• Node 4 (errors): [{'type': 'value_not_in_list', 'message': 'Value not in list', " +
  "'details': \"ckpt_name: 'v1-5-pruned-emaonly.ckpt' not in ['flux1-dev-fp8.safetensors']\", " +
  "'extra_info': {'input_name': 'ckpt_name'}}]\n• Node 4 (class_type): CheckpointLoaderSimple\n\n" +
  'Available checkpoint models: flux1-dev-fp8.safetensors';

// --- extraction -------------------------------------------------------------

test('extracts the checkpoint reference from an API-format graph', () => {
  const refs = extractModelRefs(SD15_GRAPH);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], {
    nodeId: '4',
    classType: 'CheckpointLoaderSimple',
    field: 'ckpt_name',
    value: 'v1-5-pruned-emaonly.ckpt',
  });
});

test('a wired input ["4", 1] is not mistaken for a model filename', () => {
  // clip: ['4', 1] is a connection, not a file. Only literal strings count.
  const refs = extractModelRefs({
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], clip_name: ['7', 0] } },
  });
  assert.deepEqual(refs, []);
});

test('picks up loras, vaes and unets alongside checkpoints', () => {
  const refs = extractModelRefs({
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev.safetensors' } },
    '2': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '3': { class_type: 'LoraLoader', inputs: { lora_name: 'detail.safetensors', strength_model: 1 } },
  });
  assert.deepEqual(refs.map((r) => r.field).sort(), ['lora_name', 'unet_name', 'vae_name']);
});

test('malformed graphs are skipped, never thrown on', () => {
  assert.deepEqual(extractModelRefs(null), []);
  assert.deepEqual(extractModelRefs('nope'), []);
  assert.deepEqual(extractModelRefs([1, 2, 3]), []);
  assert.deepEqual(extractModelRefs({ '4': 'not an object' }), []);
  assert.deepEqual(extractModelRefs({ '4': { class_type: 'X' } }), []);
  assert.deepEqual(extractModelRefs({ '4': { inputs: { ckpt_name: '' } } }), []);
});

test('a node with no class_type still reports its model reference', () => {
  const refs = extractModelRefs({ '4': { inputs: { ckpt_name: 'x.ckpt' } } });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].classType, '(unknown)');
});

// --- validation -------------------------------------------------------------

test('REGRESSION: catches the exact failure that cost a real GPU cold start', () => {
  const problems = validateWorkflow(SD15_GRAPH, { ckpt_name: ['flux1-dev-fp8.safetensors'] });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].nodeId, '4');
  assert.equal(problems[0].classType, 'CheckpointLoaderSimple');
  assert.equal(problems[0].received, 'v1-5-pruned-emaonly.ckpt');
  assert.deepEqual(problems[0].available, ['flux1-dev-fp8.safetensors']);
  assert.match(problems[0].message, /does not have/);
});

test('a matching checkpoint passes', () => {
  const graph = { '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev-fp8.safetensors' } } };
  assert.deepEqual(validateWorkflow(graph, { ckpt_name: ['flux1-dev-fp8.safetensors'] }), []);
});

test('an unknown field list means SILENT, not empty — no false failures', () => {
  // We were never told which loras exist, so we must not claim the lora is wrong.
  const graph = { '3': { class_type: 'LoraLoader', inputs: { lora_name: 'whatever.safetensors' } } };
  assert.deepEqual(validateWorkflow(graph, { ckpt_name: ['flux1-dev-fp8.safetensors'] }), []);
  assert.deepEqual(validateWorkflow(graph, {}), []);
  assert.deepEqual(validateWorkflow(graph, { lora_name: [] }), []);
});

test('reports every offending node, not just the first', () => {
  const graph = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.ckpt' } },
    '5': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'b.ckpt' } },
  };
  assert.equal(validateWorkflow(graph, { ckpt_name: ['flux1-dev-fp8.safetensors'] }).length, 2);
});

// --- learning the list from the first failure --------------------------------

test('extracts the available list from the live error text', () => {
  assert.deepEqual(extractAvailableFromError(LIVE_ERROR), ['flux1-dev-fp8.safetensors']);
});

test('falls back to the inline "not in [...]" form', () => {
  const err = "ckpt_name: 'x.ckpt' not in ['a.safetensors', 'b.safetensors']";
  assert.deepEqual(extractAvailableFromError(err), ['a.safetensors', 'b.safetensors']);
});

test('returns empty for an error it cannot parse, rather than guessing', () => {
  assert.deepEqual(extractAvailableFromError('something else entirely'), []);
  assert.deepEqual(extractAvailableFromError(undefined), []);
  assert.deepEqual(extractAvailableFromError(''), []);
});

test('handles a non-string error payload', () => {
  assert.deepEqual(extractAvailableFromError({ detail: LIVE_ERROR }).length > 0, true);
});

test('the list learned from the error would have caught the original graph', () => {
  // The loop closes: first failure teaches the list, list prevents the second.
  const learned = extractAvailableFromError(LIVE_ERROR);
  const problems = validateWorkflow(SD15_GRAPH, { ckpt_name: learned });
  assert.equal(problems.length, 1);
});

// --- config parsing ---------------------------------------------------------

test('parseModelList trims and drops blanks', () => {
  assert.deepEqual(parseModelList(' a.ckpt , b.ckpt ,, '), ['a.ckpt', 'b.ckpt']);
  assert.deepEqual(parseModelList(''), []);
  assert.deepEqual(parseModelList(undefined), []);
});

test('availableModelsFromEnv only sets fields that were configured', () => {
  const av = availableModelsFromEnv({ RUNPOD_AVAILABLE_CHECKPOINTS: 'flux1-dev-fp8.safetensors' });
  assert.deepEqual(av, { ckpt_name: ['flux1-dev-fp8.safetensors'] });
  assert.deepEqual(availableModelsFromEnv({}), {});
  // An empty string must not become an empty allow-list that rejects everything.
  assert.deepEqual(availableModelsFromEnv({ RUNPOD_AVAILABLE_CHECKPOINTS: '' }), {});
});
