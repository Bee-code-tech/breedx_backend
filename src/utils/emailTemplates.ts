import fs from 'fs';
import path from 'path';
import env from '../config/env';

const TEMPLATES_DIR = path.resolve(__dirname, '../../templates');
const PREVIEW_BLOCK = /[ \t]*<!-- PREVIEW ONLY[\s\S]*?<!-- \/PREVIEW ONLY -->\n?/;

const cache = new Map<string, string>();

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const loadTemplate = (name: string): string => {
  const cached = cache.get(name);
  if (cached) return cached;

  const html = fs
    .readFileSync(path.join(TEMPLATES_DIR, `${name}.html`), 'utf8')
    .replace(PREVIEW_BLOCK, '')
    .replace(/(src="|background="|url\(')assets\//g, `$1${env.API_URL}/email-assets/`);

  cache.set(name, html);
  return html;
};

// Fills {{placeholders}} in a template. Values are escaped: names come from users
export const renderEmail = (name: string, values: Record<string, string>): string =>
  loadTemplate(name).replace(/{{(\w+)}}/g, (_match, key: string) => escapeHtml(values[key] ?? ''));
