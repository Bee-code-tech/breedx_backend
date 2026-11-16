import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import env from '../../config/env';

/**
 * Claude, from Anthropic directly when ANTHROPIC_API_KEY is set, otherwise
 * from Vertex AI (signed in like the rest of Google Cloud; the models must be
 * enabled in Model Garden and have quota). Both speak the same Messages API.
 */
export const claude: Anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : (new AnthropicVertex({ projectId: env.GCP_PROJECT, region: 'global' }) as unknown as Anthropic);

export const claudeProvider = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'vertex';

export const TUTOR_MODELS = {
  /** Each live tutor beat: strong and fast. */
  tutor: process.env.TUTOR_MODEL || 'claude-sonnet-5-5',
  /** The teacher guide, built once per topic and shared: the deepest thinking. */
  guide: process.env.TUTOR_GUIDE_MODEL || 'claude-opus-5-5',
  /** Grades answers and spots learning signals after each student message. */
  listener: process.env.TUTOR_LISTENER_MODEL || 'claude-haiku-5-5',
};
