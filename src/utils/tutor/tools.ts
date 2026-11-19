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
      'Write up to 5 marks on the board as you speak — build a spatial picture (parts in zones, arrows between them), not a paragraph that pops in finished. ' +
      'Every element needs on_word (a word from this beat\'s say) so it is written in sync with your voice. Give each a new unique id. ' +
      'Pick role as the marker colour: structure chalk, term sky, flow amber (rays/motion), student lime, caution coral. ' +
      'Check board_state.space_left: when low, fade or new_board first. Flowchart only for algorithms; optics/anatomy/forces use labels + arrows in zones.',
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
                  'label: named part of the diagram (use zone). arrow: from -> to (rays, forces, flow). ' +
                  'focus_ring: dotted ring around `target`. key_point: short caption (not a full explanation). ' +
                  'equation: LaTeX in `latex`. molecule: SMILES in `smiles`. ' +
                  'flowchart: Mermaid ONLY for step processes/algorithms. ' +
                  'graph: function plot, `graph` = {"functions":["(1-x)*1500"],"x":[0,1],"y":[0,1600],"x_label":"s","y_label":"Nr"}. ' +
                  'circuit: `circuit` = a simple netlist, one part per line. chart: Vega-Lite JSON in `chart`. ' +
                  'student_tag / careful: student term or misconception callout. asset: not available yet.',
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
    description:
      'Point at existing board elements while you talk about them (pulse). Always set on_word. Prefer this over redrawing.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, on_word: onWord },
      required: ['ids', 'on_word'],
    },
  },
  {
    name: 'zoom',
    description:
      'Bring one or more board elements into view and focus the camera on them — use when the part you are discussing may be off-screen or lost on a busy board. Always set on_word.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, on_word: onWord },
      required: ['ids', 'on_word'],
    },
  },
  {
    name: 'fade',
    description: 'Fade elements to 30% when moving to a new concept (clean the board). Faded elements are cleared first when space runs out.',
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
