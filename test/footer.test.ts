import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_FOOTER, FOOTER_MAX, applyFooterPatch, footerOn, footerSummary, footerText, parseFooterArgs } from '../src/shared/footer'
import { FakeTelegram, LEO } from './fake-telegram'

describe('applyFooterPatch', () => {
  const on = { footer: '\n\nmine' }
  const off = { footer: '', savedFooter: '\n\nmine' }

  test('a new text turns it on', () => {
    expect(applyFooterPatch(on, { footer: '\n— sent by my bot' })).toEqual({ ok: true, footer: '\n— sent by my bot', savedFooter: undefined })
    expect(applyFooterPatch(off, { footer: '\n\nnew' })).toEqual({ ok: true, footer: '\n\nnew', savedFooter: undefined })
  })

  test('off keeps the text; on brings it back', () => {
    expect(applyFooterPatch(on, { enabled: false })).toEqual({ ok: true, footer: '', savedFooter: '\n\nmine' })
    expect(applyFooterPatch(off, { enabled: true })).toEqual({ ok: true, footer: '\n\nmine', savedFooter: undefined })
    // Nothing saved: the default comes back.
    expect(applyFooterPatch({ footer: '' }, { enabled: true })).toEqual({ ok: true, footer: DEFAULT_FOOTER, savedFooter: undefined })
    // Off with new text: kept for later, not sent.
    expect(applyFooterPatch(on, { enabled: false, footer: '\n\nlater' })).toEqual({ ok: true, footer: '', savedFooter: '\n\nlater' })
  })

  test('mistakes', () => {
    expect(applyFooterPatch(on, {})).toMatchObject({ ok: false, error: 'nothing to change: send footer or enabled' })
    expect(applyFooterPatch(on, { footer: '   ' })).toMatchObject({ ok: false, error: "The footer can't be empty. Turn it off instead." })
    expect(applyFooterPatch(on, { footer: 'x'.repeat(FOOTER_MAX + 1) }).ok).toBe(false)
    expect(applyFooterPatch(on, { footer: 3 }).ok).toBe(false)
    expect(applyFooterPatch(on, { enabled: 'yes' }).ok).toBe(false)
    expect(applyFooterPatch(on, { bogus: 1 })).toMatchObject({ ok: false, error: 'unknown setting: bogus' })
    expect(applyFooterPatch(on, null).ok).toBe(false)
  })

  test('control characters, direction marks and invisible-only text are refused', () => {
    const error = (footer: string) => {
      const r = applyFooterPatch(on, { footer })
      return r.ok ? null : r.error
    }
    expect(error('\n\nhi\u0007')).toBe("The footer can't contain control characters.")
    expect(error('\n\nhi\tthere')).toBe("The footer can't contain control characters.")
    expect(error('\n\n‮evil')).toBe("The footer can't contain text direction marks.")
    expect(error('\n\nhi‏')).toBe("The footer can't contain text direction marks.")
    expect(error('\n\n​‍﻿ ')).toBe("The footer can't be empty. Turn it off instead.")
    // Saving new text while switching off is checked too.
    expect(applyFooterPatch(on, { footer: '\n\n‮x', enabled: false }).ok).toBe(false)
    // Emoji built with joiners, other scripts and line breaks are fine; \r\n becomes \n.
    expect(error('\n\n👨‍👩‍👧 ස්තූතියි')).toBeNull()
    expect(applyFooterPatch(on, { footer: '\r\n\r\nline one\r\nline two' })).toEqual({ ok: true, footer: '\n\nline one\nline two', savedFooter: undefined })
  })

  test('words and state', () => {
    expect(footerOn(on)).toBe(true)
    expect(footerOn(off)).toBe(false)
    expect(footerText(off)).toBe('\n\nmine')
    expect(footerText({ footer: '' })).toBe(DEFAULT_FOOTER)
    expect(footerSummary(on)).toBe('on: "\\n\\nmine"')
    expect(footerSummary(off)).toBe('off (saved: "\\n\\nmine")')
  })

  test('cli args', () => {
    expect(parseFooterArgs([])).toEqual({ kind: 'show' })
    expect(parseFooterArgs(['off'])).toEqual({ kind: 'patch', patch: { enabled: false } })
    expect(parseFooterArgs(['on'])).toEqual({ kind: 'patch', patch: { enabled: true } })
    expect(parseFooterArgs(['—', 'sent', 'by', 'me'])).toEqual({ kind: 'patch', patch: { footer: '\n\n— sent by me' } })
    expect(parseFooterArgs(['a\\nb'])).toEqual({ kind: 'patch', patch: { footer: '\n\na\nb' } })
    expect(parseFooterArgs(['  ']).kind).toBe('error')
  })
})

describe('the footer in the daemon', () => {
  async function daemon(config: object) {
    const { createDaemon } = await import('../src/daemon/main')
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-footer-')))
    writeFileSync(paths.config, JSON.stringify(config))
    const tg = new FakeTelegram().add(LEO)
    const d = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
    return { d, paths, tg }
  }
  const post = (d: { port: number; uiToken: string }, body: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${d.port}/ui/footer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${d.uiToken}` } : {}) },
      body: JSON.stringify(body),
    })

  test('POST /ui/footer turns it off and on, and the state shows both', async () => {
    const { d, paths } = await daemon({ footer: '\n\nF' })
    expect(d.service.uiState()).toMatchObject({ footer: '\n\nF', footerText: '\n\nF', footerOn: true })
    expect((await post(d, { enabled: false })).status).toBe(200)
    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toMatchObject({ footer: '', savedFooter: '\n\nF' })
    expect(d.service.uiState()).toMatchObject({ footer: '', footerText: '\n\nF', footerOn: false })
    expect((await post(d, { footer: '\n— G' })).status).toBe(200)
    const saved = JSON.parse(readFileSync(paths.config, 'utf8'))
    expect(saved.footer).toBe('\n— G')
    expect('savedFooter' in saved).toBe(false)
    const bad = await post(d, { footer: ' ' })
    expect(bad.status).toBe(400)
    expect((await post(d, { enabled: false }, false)).status).toBe(401)
    await d.stop()
  })

  test('tgmcp footer', async () => {
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-footer-')))
    writeFileSync(paths.config, JSON.stringify({ footer: '\n\nF' }))
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), 'footer', ...args], {
        env: { ...process.env, TELEGRAM_MCP_HOME: paths.home },
        stdout: 'pipe',
        stderr: 'ignore',
      })
      return { out: await new Response(p.stdout).text(), code: await p.exited }
    }
    expect((await run()).out).toContain('Footer: on: "\\n\\nF"')
    expect((await run('off')).out).toContain('Footer: off (saved: "\\n\\nF")')
    expect((await run('—', 'me')).out).toContain('Footer: on: "\\n\\n— me"')
    expect((await run(' ')).code).toBe(1)
  })
})
