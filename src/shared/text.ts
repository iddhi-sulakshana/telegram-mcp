import { BIDI, CONTROL } from './footer'

/** Everything a reader could take as the start of a new line. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/

const UNSAFE = new RegExp(`${LINE_BREAK.source}|${CONTROL.source}|${BIDI.source}`, 'gu')

/**
 * A name from Telegram (sender, chat, file) as one line: line breaks, control characters and
 * direction marks become spaces. Names sit on header lines, so none can start a line of its own.
 */
export function oneLine(text: string): string {
  return text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
}

/** What splits the fields of our header lines (" · "), and characters that look like it. */
const FIELD_SEP = /[\u00b7\u0387\u2022\u2027\u2219\u22c5\u30fb\uff65]/gu

/**
 * A name placed among a header line's fields, like "Anna in Team QA [qa] · chat_id …": one line, with
 * no field separator or square brackets of its own, so it can't add a field or pass for a nickname.
 */
export function fieldName(text: string): string {
  return oneLine(text.replace(FIELD_SEP, '-').replace(/[[\uff3b]/g, '(').replace(/[\]\uff3d]/g, ')'))
}

/** Someone else's text shown in double quotes on a header line: a field name whose own quotes are single. */
export function inlineQuote(text: string): string {
  return fieldName(text).replace(/["\u201c\u201d\u201e\u201f\u2033\uff02]/g, "'")
}

/** A message's text after its attachment's label, "[document: a.pdf, 1 KB] caption"; `empty` when it has neither. */
export function messageBody(text: string, media: string | null, empty: string): string {
  return [media ? `[${oneLine(media)}]` : null, text].filter(Boolean).join(' ') || empty
}

/**
 * Someone else's message text, each line starting with "> ". However it is split, no line of it
 * can pass for one of our own header lines.
 */
export function quoted(text: string): string {
  return text
    .split(LINE_BREAK)
    .map(line => `> ${line}`)
    .join('\n')
}
