/** The web chat: one page and one script, served as they are (no build step, nothing from other sites). */
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(`./public/${name}`, import.meta.url), 'utf8');

export const CHAT_PAGE = read('chat.html');
export const CHAT_SCRIPT = read('chat.js');
