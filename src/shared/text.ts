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

/** Opening and closing punctuation of every kind: ( ) [ ] { } 【 】 ⟨ ⟩ ⌈ ⌉ and the rest (Unicode Ps, Pe). */
const BRACKETS = /[\p{Ps}\p{Pe}]/gu
/** Opening and closing quotation marks other than ASCII ' and " (Unicode Pi, Pf): ‘ ’ “ ” « » ‹ › and the like. */
const QUOTES = /[\p{Pi}\p{Pf}]/gu

/**
 * A name placed among a header line's fields, like "[id 123] Anna (@anna) in Team QA [qa] · chat_id …":
 * one line, NFKC-normalised (so look-alikes such as fullwidth letters and brackets become plain ones),
 * with no field separator, no brackets of any kind (each becomes a space) and its quotation marks made
 * a plain apostrophe. So it can't add a field, pass for a nickname, or carry an id of its own.
 */
export function fieldName(text: string): string {
  return oneLine(text.normalize('NFKC').replace(FIELD_SEP, '-').replace(BRACKETS, ' ').replace(QUOTES, "'"))
}

/**
 * A sender as "[id 123] Anna (@anna)": the id first, then the name, then the username if any. The id
 * is the only thing in square brackets, since fieldName takes every bracket out of the name.
 */
export function senderLabel(id: number | null, name: string, username: string | null | undefined): string {
  return `${id !== null ? `[id ${id}] ` : ''}${fieldName(name)}${username ? ` (@${username})` : ''}`
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
