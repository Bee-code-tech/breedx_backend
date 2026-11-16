import type Anthropic from '@anthropic-ai/sdk';

// BreedX Tutor tools (from docs/tutor/tools.ts, plus new_board and more board kinds).
// Claude picks MEANING (role, kind, zone); the app's layout engine picks colours and positions.

export const ROLES = ['structure', 'term', 'flow', 'student', 'caution'] as const;
export const DRAW_KINDS = [
  'asset',
  'label',
  'arrow',
  'focus_ring',
  'student_tag',
  'careful',
  'key_point',
  'equation',
  'molecule',
  'flowchart',
  'graph',
  'circuit',
  'chart',
] as const;
export const ASK_LEVELS = ['probe', 'recall', 'explain_back', 'apply', 'spot_error', 'wrap_up'] as const;

const role = {
  type: 'string',
  enum: [...ROLES],
  description: 'What the mark means. The engine maps it to the kit colour.',
};

const onWord = {
  type: 'string',
  description: "A word from this beat's `say` text. The drawing starts when the voice reaches it.",
};

export const tutorTools: Anthropic.Tool[] = [
  {
    name: 'say',
    description: 'Speak to the student. 1–3 short spoken sentences, no markdown.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 400 } },
      required: ['text'],
    },
  },
  {
    name: 'draw',
    description:
      'Add up to 5 elements to the board. Give each a new unique id so you can point back to it later. ' +
      'Check board_state.space_left first: when it is low, call new_board before drawing.',
    input_schema: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: {
                type: 'string',
                enum: [...DRAW_KINDS],
                description:
                  'asset: pre-drawn illustration (asset_id). label: text with a leader line to `target`. arrow: from -> to. ' +
                  'focus_ring: dotted ring around `target`. student_tag: the student\'s own term, tagged YOURS. careful: misconception callout. ' +
                  'key_point: short handwritten fact. equation: LaTeX in `latex`. molecule: SMILES in `smiles`. flowchart: Mermaid in `mermaid`. ' +
                  'graph: function plot, `graph` = {"functions":["(1-x)*1500"],"x":[0,1],"y":[0,1600],"x_label":"s","y_label":"Nr"}. ' +
                  'circuit: `circuit` = a simple netlist, one part per line, e.g. "V1 n1 0 230V\\nR1 n1 n2 10ohm". chart: Vega-Lite JSON in `chart`.',
              },
              role,
              text: { type: 'string' },
              asset_id: { type: 'string' },
              target: { type: 'string', description: "id of an element or an asset part, e.g. 'eye_cross_section.lens'" },
              from: { type: 'string' },
              to: { type: 'string' },
              style: { type: 'string', enum: ['solid', 'dashed', 'curved'] },
              latex: { type: 'string' },
              smiles: { type: 'string' },
              mermaid: { type: 'string' },
              graph: { type: 'object' },
              circuit: { type: 'string' },
              chart: { type: 'object' },
              zone: { type: 'string', enum: ['main', 'top', 'bottom', 'left', 'right'], description: 'Rough placement; the engine finalises it.' },
              on_word: onWord,
            },
            required: ['id', 'kind', 'role'],
          },
        },
      },
      required: ['elements'],
    },
  },
  {
    name: 'highlight',
    description: 'Pulse existing board elements you are referring to (instead of redrawing them).',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, on_word: onWord },
      required: ['ids'],
    },
  },
  {
    name: 'fade',
    description: 'Fade elements to 30% when moving to a new concept. Faded elements are cleared first when space runs out.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
  },
  {
    name: 'new_board',
    description:
      'Wipe the board and start a fresh one, e.g. for a new concept or when space_left is low. The old board is kept for the student to look back at. ' +
      '`keep` carries a few ids over, shrunk into a recap corner. Call it before this beat\'s draw, never mid-sentence.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short heading for the new board.' },
        keep: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      },
      required: ['title'],
    },
  },
  {
    name: 'write_note',
    description: 'Write one short note (under 15 words) in the notes panel.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 120 },
        kind: { type: 'string', enum: ['note', 'student_term', 'caution'] },
      },
      required: ['text', 'kind'],
    },
  },
  {
    name: 'ask',
    description: 'Ask the student something and wait. Ends the beat.',
    input_schema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string' },
        level: { type: 'string', enum: [...ASK_LEVELS] },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Only for multiple choice.' },
        expected: { type: 'string', description: 'What a correct answer must contain. Used by the grader, never shown.' },
      },
      required: ['goal_id', 'level', 'question', 'expected'],
    },
  },
  {
    name: 'request_advance',
    description: 'Ask to move to the next goal. Your code accepts only if recall, explain_back and apply/spot_error were all passed.',
    input_schema: {
      type: 'object',
      properties: { goal_id: { type: 'string' }, evidence: { type: 'string' } },
      required: ['goal_id', 'evidence'],
    },
  },
];
