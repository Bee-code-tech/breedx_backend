// BreedX Tutor — tool definitions (Anthropic Messages API format, works on Vertex AI)
// Claude picks MEANING (role, kind, zone); your layout engine picks colours and positions.

const role = {
  type: "string",
  enum: ["structure", "term", "flow", "student", "caution"],
  description: "What the mark means. The engine maps it to the kit colour.",
};

const onWord = {
  type: "string",
  description: "A word from this beat's `say` text. The drawing starts when the voice reaches it.",
};

export const tutorTools = [
  {
    name: "say",
    description: "Speak to the student. 1–3 short spoken sentences, no markdown.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 400 } },
      required: ["text"],
    },
  },
  {
    name: "draw",
    description: "Add up to 5 elements to the board. Give each a new unique id so you can point back to it later.",
    input_schema: {
      type: "object",
      properties: {
        elements: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: {
                type: "string",
                enum: [
                  "asset",        // pre-drawn illustration from the teacher guide (asset_id)
                  "label",        // text with a leader line to `target`
                  "arrow",        // from -> to, style solid|dashed|curved
                  "focus_ring",   // dotted ring around `target`
                  "student_tag",  // the student's own term, tagged YOURS
                  "careful",      // misconception callout
                  "key_point",    // short handwritten fact with a marker
                  "equation",     // latex
                  "molecule",     // smiles
                  "flowchart",    // mermaid
                ],
              },
              role,
              text: { type: "string" },
              asset_id: { type: "string" },
              target: { type: "string", description: "id of an element or an asset part, e.g. 'eye_cross_section.lens'" },
              from: { type: "string" },
              to: { type: "string" },
              style: { type: "string", enum: ["solid", "dashed", "curved"] },
              latex: { type: "string" },
              smiles: { type: "string" },
              mermaid: { type: "string" },
              zone: { type: "string", enum: ["main", "top", "bottom", "left", "right"], description: "Rough placement; the engine finalises it." },
              on_word: onWord,
            },
            required: ["id", "kind", "role"],
          },
        },
      },
      required: ["elements"],
    },
  },
  {
    name: "highlight",
    description: "Pulse existing board elements you are referring to (instead of redrawing them).",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } }, on_word: onWord },
      required: ["ids"],
    },
  },
  {
    name: "fade",
    description: "Fade elements to 30% when moving to a new concept.",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
  {
    name: "write_note",
    description: "Write one short note (under 15 words) in the notes panel.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 120 },
        kind: { type: "string", enum: ["note", "student_term", "caution"] },
      },
      required: ["text", "kind"],
    },
  },
  {
    name: "ask",
    description: "Ask the student something and wait. Ends the beat.",
    input_schema: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        level: { type: "string", enum: ["probe", "recall", "explain_back", "apply", "spot_error", "wrap_up"] },
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, maxItems: 4, description: "Only for multiple choice." },
        expected: { type: "string", description: "What a correct answer must contain. Used by the grader, never shown." },
      },
      required: ["goal_id", "level", "question", "expected"],
    },
  },
  {
    name: "request_advance",
    description: "Ask to move to the next goal. Your code accepts only if recall, explain_back and apply/spot_error were all passed.",
    input_schema: {
      type: "object",
      properties: { goal_id: { type: "string" }, evidence: { type: "string" } },
      required: ["goal_id", "evidence"],
    },
  },
];
