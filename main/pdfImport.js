'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');
const { readPdfText, PdfReadError } = require('./pdfText');
const { findPersonSchedules, scheduleMemo } = require('./pdfSchedule');
const { localDateKey } = require('./schedule');

const MAX_PERSON_LENGTH = 40;
const MAX_EVENTS = 1000;
const MAX_TITLE_LENGTH = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanPerson(value) {
  if (typeof value !== 'string') return '';
  const person = value.trim().replace(/\s+/g, ' ').slice(0, MAX_PERSON_LENGTH);
  // 한 글자는 거의 모든 칸에 걸리므로 받지 않는다.
  return person.replace(/\s/g, '').length >= 2 ? person : '';
}

function describe(err) {
  if (err instanceof PdfReadError) return err.message;
  if (err && err.code === 'ENOENT') return '파일을 찾을 수 없습니다.';
  if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY')) return '파일을 읽을 수 없습니다. 다른 프로그램에서 열려 있는지 확인하세요.';
  return `PDF를 읽지 못했습니다: ${err && err.message ? err.message : err}`;
}

/** 달력 창의 "PDF에서 일정 가져오기". PDF에서 특정인의 일정을 찾아 메모 하나로 만든다. */
class PdfImport {
  constructor({ calendar, settings, createNote }) {
    this.calendar = calendar;
    this.settings = settings;
    this.createNote = createNote;
    // 이름만 바꿔 다시 찾을 때 PDF를 또 읽지 않는다.
    this.cache = null;
  }

  get lastPerson() {
    const value = (this.settings.get('calendar') || {}).importPerson;
    return typeof value === 'string' ? value : '';
  }

  async pick() {
    const result = await dialog.showOpenDialog(this.calendar.win, {
      title: '일정이 담긴 PDF 선택',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  async _pages(filePath) {
    const { mtimeMs, size } = await fs.stat(filePath);
    const cached = this.cache;
    if (cached && cached.filePath === filePath && cached.mtimeMs === mtimeMs && cached.size === size) return cached.pages;
    const pages = await readPdfText(filePath);
    this.cache = { filePath, mtimeMs, size, pages };
    return pages;
  }

  async read(filePath, rawPerson) {
    const person = cleanPerson(rawPerson);
    if (!person) return { error: '이름을 두 글자 이상 입력하세요.' };
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.pdf') {
      return { error: 'PDF 파일만 읽을 수 있습니다.' };
    }
    this.settings.set('calendar', { ...this.settings.get('calendar'), importPerson: person });
    try {
      const pages = await this._pages(filePath);
      const year = Number(localDateKey().slice(0, 4));
      const { events, layouts } = findPersonSchedules(pages, person, year);
      return {
        person,
        fileName: path.basename(filePath),
        events: events.slice(0, MAX_EVENTS),
        pageCount: pages.length,
        textless: layouts.every((entry) => entry.layout === 'empty'),
        noMonthPages: layouts.filter((entry) => entry.month === null && entry.layout !== 'list' && entry.layout !== 'empty').map((entry) => entry.page),
      };
    } catch (err) {
      return { error: describe(err) };
    }
  }

  add(rawPerson, rawFileName, rawEvents) {
    const person = cleanPerson(rawPerson);
    const fileName = typeof rawFileName === 'string' ? path.basename(rawFileName).slice(0, 120) : 'PDF';
    const events = Array.isArray(rawEvents) ? rawEvents.slice(0, MAX_EVENTS).filter((event) => event
      && typeof event.date === 'string' && DATE_RE.test(event.date)
      && typeof event.title === 'string' && event.title.trim()) : [];
    if (!person || !events.length) return { error: '추가할 일정이 없습니다.' };
    const clean = events.map((event) => ({ date: event.date, title: event.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) }));
    const record = this.createNote(scheduleMemo(person, fileName, clean));
    return { noteId: record.id, count: clean.length };
  }
}

module.exports = { PdfImport, cleanPerson };
