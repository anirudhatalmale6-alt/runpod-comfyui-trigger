import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_YOUR_PROJECT_REF",
  runtime: "node",

  // RAISED from 300.
  //
  // The RunPod polling deadline defaults to 600s, and a ComfyUI render that
  // "consistently exceeds 30 seconds" can sit in a cold-start queue well beyond
  // that. maxDuration MUST comfortably exceed the polling deadline or the task
  // is killed mid-poll and you lose the job without ever reading its result.
  //
  // Keep this invariant: maxDuration > the deadlineSeconds you pass the task.
  maxDuration: 3600,

  dirs: ["./src/trigger"],

  build: {
    extensions: [],
  },
});
