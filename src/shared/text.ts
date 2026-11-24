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
 * Round and square brackets, and characters that look like them (fullwidth, small, super- and
 * subscript, ornate, white and the like). Our header lines put a name's id and username in round
 * brackets and a saved nickname in square ones.
 */
const BRACKETS =
  /[()[\]\uff08\uff09\uff3b\uff3d\ufe59\ufe5a\ufe5d\ufe5e\u207d\u207e\u208d\u208e\ufd3e\ufd3f\u2768-\u276b\u27ee\u27ef\u27e6\u27e7\u2985\u2986\u2e28\u2e29\u3014\u3015\u3018\u3019\u301a\u301b]/gu

/**
 * A name placed among a header line's fields, like "Anna (@anna, id 123) in Team QA [qa] · chat_id …":
 * one line, with no field separator and no brackets of its own (each becomes a space), so it can't add
 * a field, pass for a nickname, or show an id of its own ahead of the real "(id N)".
 */
export function fieldName(text: string): string {
  return oneLine(text.replace(FIELD_SEP, '-').replace(BRACKETS, ' '))
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
