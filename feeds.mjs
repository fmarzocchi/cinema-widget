/**
 * Feed film per il widget Nothing OS — Roma.
 *
 * Recupera la programmazione di tre sale e scrive in docs/:
 *   cinema.json      tutte e tre le sale insieme: è il file che legge il widget
 *   porta.json       UCI Cinemas Porta di Roma   (API JSON del sito UCI)
 *   troisi.json      Cinema Troisi               (pagina settimanale Liveticket)
 *   andromeda.json   Multisala Andromeda         (schede film 18tickets)
 *
 * Nessuna libreria da installare: gira con Node 22 così com'è.
 * Se una sala non risponde, il suo feed precedente resta pubblicato e l'HTML
 * ricevuto finisce in debug/ per capire cosa è cambiato.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS = join(ROOT, 'docs');
const DEBUG = join(ROOT, 'debug');
const CACHE = join(ROOT, 'cache', 'tmdb.json');

const RATING_SCALE = Number(process.env.RATING_SCALE || 10); // 10 = voto come su TMDB (7.6), 5 = diviso a metà (3.8)
const GIORNI = 7; // quanti giorni di programmazione raccogliere

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ========================================================== utility base == */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { retries = 3, timeoutMs = 20000, accept, body, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'it-IT,it;q=0.9',
          ...(accept ? { Accept: accept } : {}),
          ...headers,
        },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        // "Troppe richieste": si aspetta sul serio (Retry-After se c'è, altrimenti 20s, 40s, 60s…).
        const dopo = Number(res.headers.get('retry-after'));
        const err = new Error('HTTP 429 (troppe richieste)');
        err.status = 429;
        err.attesa = Number.isFinite(dopo) && dopo > 0 ? dopo * 1000 : 20000 * (attempt + 1);
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (err.status === 404) break; // la pagina non c'è: riprovare non serve
      if (attempt < retries) await sleep(err.attesa ?? 800 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const fetchJson = async (url, opts) => JSON.parse(await fetchText(url, { ...opts, accept: 'application/json' }));

/** Oggi a Roma (il server di GitHub lavora in UTC, quindi va forzato il fuso). */
export function oggiRoma(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function piuGiorni(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const intervallo = (da, giorni) => Array.from({ length: giorni }, (_, i) => piuGiorni(da, i));

/** Giorni da "da" ad "a" (date ISO): positivo se "a" viene dopo. */
export function giorniTra(da, a) {
  const utc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(a) - utc(da)) / 86400000);
}

/** "22/09/2026" -> "2026-09-22" */
export function dataItaISO(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str).trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** "20.30" o "20:30" -> "20:30" */
export function orario(str) {
  const m = /^(\d{1,2})[.:](\d{2})$/.exec(String(str).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const unici = (a) => [...new Set(a)];

/* ---------------------------------------------------------------- titoli -- */

const RUMORE = [
  /\bv\.?\s?o\.?\s?s\.?\b/gi,
  /\bv\.?\s?o\.?\b/gi,
  /\bsott\.?\s?ita\.?\b/gi,
  /\bversione originale\b/gi,
  /\b(imax|4dx|3d|2d|atmos|xl)\b/gi,
  /\(cinemini\)/gi,
  /\bcinemini\b/gi,
  /\bcinema in festa\b/gi,
  /\bevento\s*\d*\b/gi,
  /\(\s*\d+\s*h\s*\d{0,2}\s*['’]?\s*\)/gi, // durata tipo "(1H50')" nei titoli dell'Andromeda
  /\bc\.a\.(?=\s|$)/gi, // "Contenuto Alternativo": così UCI marca concerti ed eventi
];

export function titoloPulito(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  for (const re of RUMORE) t = t.replace(re, ' ');
  return t
    .replace(/:(?=\p{L})/gu, ': ') // "CARS:MOTORI" -> "CARS: MOTORI"
    .replace(/\s*\(\s*\)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[\s\-–—.,:;·]+$/, ''); // resti come "- ." dopo aver tolto "V. O."
}

// Parole che in un titolo restano minuscole (tranne all'inizio o dopo ":" e " - ").
const PAROLE_PICCOLE = new Set(
  ('a ad al allo alla ai agli alle e ed di da dal dallo dalla dai dagli dalle del dello della dei degli delle ' +
    'in nel nello nella nei negli nelle con su sul sullo sulla sui sugli sulle per tra fra il lo la i gli le un uno una o ' +
    'of the and to on at for vs')
    .split(' '),
);

/** Titoli TUTTI MAIUSCOLI -> maiuscole sensate. Quelli che hanno già minuscole restano com'erano. */
export function capitalizza(titolo) {
  const t = String(titolo || '');
  if (!t || /\p{Ll}/u.test(t)) return t;
  let inizio = true;
  return t
    .toLowerCase()
    .split(' ')
    .map((parola) => {
      const nuda = parola.replace(/[^\p{L}']/gu, '');
      const risultato = !inizio && PAROLE_PICCOLE.has(nuda) ? parola : parola.replace(/\p{L}/u, (c) => c.toUpperCase());
      inizio = parola === '-' || parola === '–' || /[:.?!]$/.test(parola);
      return risultato;
    })
    .join(' ');
}

export function chiaveTitolo(raw) {
  return titoloPulito(raw)
    .replace(/&/g, ' e ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const inLinguaOriginale = (raw) =>
  /\bv\.?\s?o\.?\s?s?\.?\b|\bsott\.?\s?ita\b|versione originale/i.test(String(raw || ''));

/* ------------------------------------------------------------------ HTML -- */

const ENTITA = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘',
  ndash: '–', mdash: '—', hellip: '…', egrave: 'è', eacute: 'é', agrave: 'à', aacute: 'á',
  ograve: 'ò', oacute: 'ó', igrave: 'ì', iacute: 'í', ugrave: 'ù', uacute: 'ú', uuml: 'ü',
  ouml: 'ö', auml: 'ä', ccedil: 'ç', ntilde: 'ñ', Egrave: 'È', Eacute: 'É', Agrave: 'À',
};

/** "&#39;" "&#x27;" "&egrave;" -> caratteri veri (i titoli arrivano spesso così dai meta tag). */
export function decodificaEntita(testo) {
  return String(testo)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (tutto, nome) => ENTITA[nome] ?? tutto);
}

export function senzaTag(html) {
  return decodificaEntita(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d|td|th|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Righe di tabella, ovunque si trovino: evita i problemi delle tabelle annidate. */
function righeTabella(html) {
  return String(html)
    .split(/<tr\b/i)
    .slice(1)
    .map((pezzo) => pezzo.split(/<\/tr>/i)[0]);
}

/** Celle di una riga, con il loro contenuto HTML (senza gli attributi del tag). */
export function celle(riga) {
  return String(riga)
    .split(/<t[dh]\b/i)
    .slice(1)
    .map((pezzo) => pezzo.split(/<\/t[dh]>/i)[0].replace(/^[^>]*>/, ''));
}

/** Contenuto di un <meta property="..."> o <meta name="...">, comunque sia scritto. */
function meta(html, prop) {
  const tag = new RegExp(`<meta[^>]*(?:property|name)=["']${prop}["'][^>]*>`, 'i').exec(html)?.[0];
  if (!tag) return null;
  const valore = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return valore ? decodificaEntita(valore) : null;
}

/* ================================================== PORTA — API UCI JSON == */

const UCI_API =
  'https://myuci---uci-backend-production-nfluwp7wga-oc.a.run.app/api/theatres/uci-cinemas-porta-di-roma-roma/programming/';

function uciProiezioni(film, data) {
  const out = [];
  for (const gruppo of film.screens || []) {
    if (!gruppo || typeof gruppo !== 'object') continue;
    for (const [formato, varianti] of Object.entries(gruppo)) {
      if (!Array.isArray(varianti)) continue;
      for (const v of varianti) {
        if (!v || typeof v !== 'object') continue;
        const sala = v.screen?.name || formato || null;
        for (const p of v.performances || []) {
          if (!p || typeof p !== 'object') continue;
          if (p.day && p.day !== data) continue; // la risposta può contenere più giorni
          const ora = String(p.actual_start_at || p.start_at || '').slice(0, 5);
          if (/^\d{2}:\d{2}$/.test(ora)) out.push({ data, ora, sala });
        }
      }
    }
  }
  return out;
}

export function leggiUci(risposta, data, acc = new Map()) {
  for (const film of Array.isArray(risposta?.data) ? risposta.data : []) {
    // UCI restituisce tutto il catalogo: "not_today" marca i film senza proiezioni quel giorno.
    if (film?.not_today === true) continue;
    const titolo = String(film?.title || '').trim();
    if (!titolo) continue;

    const proiezioni = uciProiezioni(film, data);
    if (!proiezioni.length) continue;

    const esistente = acc.get(titolo);
    if (esistente) {
      esistente.proiezioni.push(...proiezioni);
      continue;
    }

    const poster = String(film.poster || film.top_image || '');
    acc.set(titolo, {
      titolo,
      poster: poster.startsWith('http') ? poster : null,
      link: film.slug ? `https://ucicinemas.it/film/${film.slug}/` : 'https://ucicinemas.it/',
      proiezioni,
    });
  }
  return acc;
}

async function scaricaPorta(oggi) {
  const avvisi = [];
  const acc = new Map();
  for (const data of intervallo(oggi, GIORNI)) {
    try {
      const risposta = await fetchJson(UCI_API + data);
      if (!Array.isArray(risposta?.data) || !risposta.data.length) {
        avvisi.push(`Porta ${data}: risposta senza film`);
        continue;
      }
      leggiUci(risposta, data, acc);
    } catch (err) {
      avvisi.push(`Porta ${data}: ${err.message}`);
    }
  }
  return { film: [...acc.values()], avvisi };
}

/* ============================================ TROISI — pagina Liveticket == */

const TROISI_BASE = 'https://cinematroisi.liveticket.it';
const GIORNO_INTESTAZIONE = /\b(lun|mar|mer|gio|ven|sab|dom)\w*\.?\s*(\d{1,2})\b/i;

function assoluto(url, base) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Associa ogni colonna della tabella orari alla sua data. */
function colonneInDate(testiIntestazione, inizioSettimana) {
  // La tabella potrebbe partire qualche giorno prima di oggi: si cerca il numero del
  // giorno in una finestra da una settimana prima a due dopo. Sotto i 28 giorni ogni
  // numero compare una volta sola, quindi l'abbinamento resta univoco.
  const candidate = intervallo(piuGiorni(inizioSettimana, -7), 21);
  const posizionali = intervallo(inizioSettimana, 14);
  const colonne = new Map();
  let posizione = 0;
  testiIntestazione.forEach((testo, indice) => {
    const m = GIORNO_INTESTAZIONE.exec(testo);
    if (!m) return;
    const giorno = Number(m[2]);
    colonne.set(indice, candidate.find((iso) => Number(iso.slice(8, 10)) === giorno) || posizionali[posizione] || null);
    posizione++;
  });
  return colonne;
}

function orariIn(testo) {
  const out = [];
  for (const m of String(testo).matchAll(/\b([0-2]?\d)[.:]([0-5]\d)\b/g)) {
    const o = orario(`${m[1]}:${m[2]}`);
    if (o) out.push(o);
  }
  return out;
}

/**
 * Struttura reale (verificata sul sito il 23/09/2026): ogni film è un blocco con il
 * titolo in un <h1>, la locandina in un <img> e una tabella orari piccola, la cui
 * intestazione sono i 7 giorni ("Mer 23" … "Mar 29") e il corpo gli orari per colonna.
 * Il parser prende ogni tabella con intestazione a giorni e le assegna l'ultimo <h1>
 * e l'ultima <img> che la precedono: non dipende dai nomi delle classi CSS.
 */
export function leggiTroisi(html, inizioSettimana) {
  // Il sito lascia nell'HTML una copia commentata di ogni tabella: va tolta.
  const pulito = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const film = new Map();
  let intestazioneTrovata = false;

  for (const t of pulito.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const tabella = t[0];
    const righe = righeTabella(tabella);
    if (righe.length < 2) continue;

    const intestazione = celle(righe[0]).map((c) => senzaTag(c).replace(/\s+/g, ' ').trim());
    if (intestazione.filter((x) => GIORNO_INTESTAZIONE.test(x)).length < 3) continue;
    intestazioneTrovata = true;
    const colonne = colonneInDate(intestazione, inizioSettimana);

    const prima = pulito.slice(0, t.index);
    const h1 = [...prima.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].at(-1);
    if (!h1) continue;
    const titoloGrezzo = senzaTag(h1[1]).replace(/\s+/g, ' ').trim();
    if (!titoloGrezzo) continue;

    // Spettacoli dopo mezzanotte: il sito li mette nella colonna della sera prima con
    // l'orario segnaposto "23.59" e l'orario vero in coda al titolo ("Odissea - VOS 00.30").
    const oraNelTitolo = /\s+([0-2]?\d)[.:]([0-5]\d)$/.exec(titoloGrezzo);
    const titolo = oraNelTitolo ? titoloGrezzo.slice(0, oraNelTitolo.index).trim() : titoloGrezzo;
    const oraVera = oraNelTitolo ? orario(`${oraNelTitolo[1]}:${oraNelTitolo[2]}`) : null;

    const img = [...prima.slice(h1.index).matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].at(-1);
    const opera = /opera\.aspx\?Id=(\d+)/i.exec(tabella)?.[1];

    const proiezioni = [];
    for (const riga of righe.slice(1)) {
      const testi = celle(riga).map((c) => senzaTag(c));
      for (const [indice, data] of colonne) {
        if (!data || indice >= testi.length) continue;
        for (const ora of orariIn(testi[indice])) {
          if (oraVera && ora === '23:59') {
            const dopoMezzanotte = Number(oraVera.slice(0, 2)) < 6;
            proiezioni.push({ data: dopoMezzanotte ? piuGiorni(data, 1) : data, ora: oraVera, sala: null });
          } else {
            proiezioni.push({ data, ora, sala: null });
          }
        }
      }
    }
    if (!proiezioni.length) continue;

    const esistente = film.get(titolo);
    if (esistente) {
      esistente.proiezioni.push(...proiezioni);
    } else {
      film.set(titolo, {
        titolo,
        poster: assoluto(img?.[1], TROISI_BASE),
        link: opera ? `https://www.liveticket.it/opera.aspx?Id=${opera}` : TROISI_BASE,
        proiezioni,
      });
    }
  }

  return { film: [...film.values()], intestazioneTrovata };
}

async function scaricaTroisi(oggi) {
  const url = `${TROISI_BASE}/eventi/?data=${oggi}&vista=xtitolo`;
  let html;
  try {
    html = await fetchText(url);
  } catch (err) {
    return { film: [], avvisi: [`Troisi: ${err.message}`] };
  }
  const { film, intestazioneTrovata } = leggiTroisi(html, oggi);
  const avvisi = [];
  if (!intestazioneTrovata) avvisi.push('Troisi: tabelle orari non riconosciute');
  else if (!film.length) avvisi.push('Troisi: tabelle trovate ma nessun film estratto');
  return { film, avvisi, grezzo: film.length ? null : html };
}

/* ============================================ ANDROMEDA — schede 18tickets == */

const ANDROMEDA_BASE = 'https://roma.andromeda.18tickets.it';
// Alterna una data (gg/mm/aaaa) e un orario, con l'eventuale sala subito dopo.
const DATA_O_ORA = /(\d{1,2}\/\d{1,2}\/\d{4})|([0-2]?\d:[0-5]\d)(?:\s*-?\s*(Sala\s*[\w.]+))?/g;
const PRIMA_ORA_PLAUSIBILE = 6; // sotto le 06:00 è la durata del film, non uno spettacolo
const PAUSA_ANDROMEDA_MS = Number(process.env.PAUSA_ANDROMEDA_MS ?? 3000);

export function leggiLinkAndromeda(html) {
  const trovati = new Map();
  for (const m of String(html).matchAll(/<a[^>]+href=["'][^"']*\/film\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const id = m[1];
    const testo = senzaTag(m[2]).replace(/\s+/g, ' ').trim();
    const precedente = trovati.get(id);
    // Lo stesso film compare più volte (locandina + titolo): si tiene il testo migliore.
    if (!precedente || testo.length > precedente.length) trovati.set(id, testo);
  }
  return [...trovati.entries()].map(([id, titolo]) => ({ id, titolo, url: `${ANDROMEDA_BASE}/film/${id}` }));
}

export function leggiSchedaAndromeda(html, { titolo: ripiego, url }) {
  const candidati = [
    meta(html, 'og:title'),
    senzaTag(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || ''),
    senzaTag(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').split('|')[0],
  ];
  const titolo =
    candidati.map((c) => String(c || '').replace(/\s+/g, ' ').trim()).find((c) => c.length > 1 && !/^andromeda/i.test(c)) ||
    ripiego;

  const ogImage = meta(html, 'og:image');
  const poster = ogImage ? assoluto(ogImage, ANDROMEDA_BASE) : null;

  const proiezioni = [];
  let dataCorrente = null;
  for (const m of senzaTag(html).matchAll(DATA_O_ORA)) {
    if (m[1]) {
      dataCorrente = dataItaISO(m[1]);
      continue;
    }
    if (!dataCorrente || !m[2]) continue;
    const [h, min] = m[2].split(':').map(Number);
    if (h < PRIMA_ORA_PLAUSIBILE) continue;
    proiezioni.push({
      data: dataCorrente,
      ora: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
      sala: m[3] ? m[3].replace(/\s+/g, ' ').trim() : null,
    });
  }

  return { titolo, poster, link: url, proiezioni };
}

async function scaricaAndromeda() {
  const avvisi = [];
  let home;
  try {
    home = await fetchText(ANDROMEDA_BASE);
  } catch (err) {
    return { film: [], avvisi: [`Andromeda: ${err.message}`] };
  }

  const link = leggiLinkAndromeda(home);
  if (!link.length) {
    return { film: [], avvisi: ['Andromeda: nessuna scheda film trovata in home'], grezzo: home };
  }

  const film = [];
  let primaScheda = null;
  for (const [i, l] of link.entries()) {
    // Il sito risponde 429 dopo una ventina di richieste ravvicinate (verificato il
    // 23/09/2026): una scheda ogni 3 secondi resta sotto il limite.
    if (i > 0) await sleep(PAUSA_ANDROMEDA_MS);
    try {
      const html = await fetchText(l.url);
      primaScheda ||= html;
      const scheda = leggiSchedaAndromeda(html, l);
      if (scheda.proiezioni.length) film.push(scheda);
    } catch (err) {
      avvisi.push(`Andromeda ${l.id}: ${err.message}`);
    }
  }
  if (!film.length) avvisi.push(`Andromeda: ${link.length} schede lette, nessuno spettacolo estratto`);
  return { film, avvisi, grezzo: film.length ? null : primaScheda };
}

/* ============================ locandine, voti e date (TMDB + altre fonti) == */

const TMDB = 'https://api.themoviedb.org/3';
const GIORNI_CACHE_TROVATO = 7; // i voti cambiano: ogni film viene ricontrollato una volta a settimana
const GIORNI_CACHE_NON_TROVATO = 2;
const VOTI_MINIMI_UTENTI = 10; // IMDb e Letterboxd: sotto questa soglia il voto è rumore
// Cambia quando cambiano le regole di abbinamento: le voci vecchie vengono ricontrollate.
const VERSIONE_CACHE = 5;

const arrotonda1 = (n) => Math.round(n * 10) / 10;

/**
 * Media dei voti disponibili, tutti già in decimi. Un sito senza voto (null) o con 0 non
 * entra nella media; se non ne resta nessuno il risultato è null ("n.a." sul widget).
 */
export function mediaVoti(fonti) {
  const validi = Object.values(fonti || {}).filter((v) => Number.isFinite(v) && v > 0);
  if (!validi.length) return null;
  return arrotonda1(validi.reduce((a, b) => a + b, 0) / validi.length);
}

/**
 * Letterboxd: voto medio (su 5) dal JSON-LD della scheda, con ripiego sul meta
 * "twitter:data2" ("3.91 out of 5"). Restituisce il voto in decimi o null.
 */
export function leggiLetterboxd(html) {
  for (const m of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const testo = m[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\//g, '').trim();
    let dati;
    try {
      dati = JSON.parse(testo);
    } catch {
      continue;
    }
    const a = dati?.aggregateRating;
    const valore = Number(a?.ratingValue);
    if (!Number.isFinite(valore) || valore <= 0) continue;
    const conteggio = Number(a.ratingCount ?? a.reviewCount);
    if (Number.isFinite(conteggio) && conteggio < VOTI_MINIMI_UTENTI) return null;
    const scala = Number(a.bestRating) > 0 ? Number(a.bestRating) : 5;
    return arrotonda1((valore / scala) * 10);
  }
  const m = /([\d.]+)\s+out of\s+5/i.exec(meta(html, 'twitter:data2') || '');
  return m && Number(m[1]) > 0 ? arrotonda1(Number(m[1]) * 2) : null;
}

/**
 * IMDb (voto degli utenti) dal dataset ufficiale title.ratings.tsv.gz, aggiornato ogni giorno
 * e libero per uso personale: le pagine del sito bloccano i server di GitHub, il dataset no.
 * Riga: "tt15398776<TAB>8.2<TAB>1099285". Restituisce Map id -> { voto, voti }.
 */
export async function filtraRigheImdb(righe, ids) {
  const cercati = new Set(ids);
  const trovati = new Map();
  if (!cercati.size) return trovati;
  for await (const riga of righe) {
    const tab = riga.indexOf('\t');
    if (tab < 0 || !cercati.has(riga.slice(0, tab))) continue;
    const [id, media, numero] = riga.split('\t');
    const voti = Number(numero) || 0;
    trovati.set(id, { voto: Number(media) > 0 && voti >= VOTI_MINIMI_UTENTI ? arrotonda1(Number(media)) : null, voti });
    if (trovati.size === cercati.size) break;
  }
  return trovati;
}

const IMDB_DATASET = 'https://datasets.imdbws.com/title.ratings.tsv.gz';

async function votiImdb(ids) {
  const res = await fetch(IMDB_DATASET, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const righe = createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity });
  try {
    return await filtraRigheImdb(righe, ids);
  } finally {
    righe.close();
  }
}

/** Metacritic: indirizzo della scheda dal titolo inglese ("Coyote vs. Acme" -> "coyote-vs-acme"). */
export function slugMetacritic(titolo) {
  return String(titolo || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Metacritic: nome, anno e Metascore (su 100, portato in decimi) dal JSON-LD della scheda.
 * "Metascore TBD" (poche recensioni) non ha aggregateRating: voto null.
 */
export function leggiMetacritic(html) {
  for (const m of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d;
    try {
      d = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (d?.['@type'] !== 'Movie') continue;
    const anno = Number(String(d.datePublished || '').slice(0, 4)) || null;
    const a = d.aggregateRating;
    const valore = Number(a?.ratingValue);
    const scala = Number(a?.bestRating) > 0 ? Number(a.bestRating) : 100;
    return { nome: d.name || null, anno, voto: valore > 0 ? arrotonda1((valore / scala) * 10) : null };
  }
  return null;
}

/**
 * Si prova "titolo", poi "titolo-anno" (Metacritic distingue così gli omonimi: "resident-evil" è
 * il film del 2002, "resident-evil-2026" quello nuovo). Vale solo una scheda dell'anno giusto (±1).
 */
async function votoMetacritic(titoloInglese, anni) {
  const slug = slugMetacritic(titoloInglese);
  if (!slug || !anni.length) return null;
  const annoGiusto = (a) => Boolean(a) && anni.some((x) => Math.abs(x - a) <= 1);
  const tentativi = unici([slug, ...anni.map((a) => `${slug}-${a}`)]);
  for (const [i, s] of tentativi.entries()) {
    if (i > 0) await sleep(500);
    let html;
    try {
      html = await fetchText(`https://www.metacritic.com/movie/${s}/`, { retries: 1 });
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
    const scheda = leggiMetacritic(html);
    if (scheda && annoGiusto(scheda.anno)) return scheda.voto;
  }
  return null;
}

/**
 * MUBI: tra i risultati della ricerca vale solo un film con lo stesso titolo (inglese, originale
 * o italiano) e l'anno giusto (±1: MUBI usa l'anno del festival). A parità, quello con più voti.
 * Restituisce { voto } (voto in decimi o null se ha troppi pochi voti) oppure null se non c'è.
 */
export function scegliMubi(films, titoli, anni) {
  const chiavi = new Set(titoli.map(chiaveTitolo).filter(Boolean));
  const annoGiusto = (a) => Boolean(a) && anni.some((x) => Math.abs(x - a) <= 1);
  const candidati = (Array.isArray(films) ? films : []).filter((f) => {
    // "수유천  | Suyoocheon": titolo originale e traslitterazione separati da "|".
    const nomi = [f?.title, ...String(f?.original_title || '').split('|')].map(chiaveTitolo).filter(Boolean);
    return annoGiusto(Number(f?.year)) && nomi.some((n) => chiavi.has(n));
  });
  if (!candidati.length) return null;
  candidati.sort((a, b) => (Number(b.number_of_ratings) || 0) - (Number(a.number_of_ratings) || 0));
  const f = candidati[0];
  const voti = Number(f.number_of_ratings) || 0;
  const valore = Number(f.average_rating_out_of_ten) || (Number(f.average_rating) > 0 ? Number(f.average_rating) * 2 : 0);
  return { voto: valore > 0 && voti >= VOTI_MINIMI_UTENTI ? arrotonda1(valore) : null };
}

const MUBI_RICERCA = 'https://api.mubi.com/v3/search/films';

async function votoMubi(titoli, anni) {
  const ricerche = unici(titoli.slice(0, 2).filter(Boolean));
  if (!anni.length || !ricerche.length) return null;
  for (const [i, q] of ricerche.entries()) {
    if (i > 0) await sleep(500);
    const dati = JSON.parse(
      await fetchText(`${MUBI_RICERCA}?query=${encodeURIComponent(q)}&per_page=10`, {
        retries: 1,
        accept: 'application/json',
        headers: { Client: 'web', 'Client-Country': 'IT' },
      }),
    );
    const scelta = scegliMubi(dati?.films, titoli, anni);
    if (scelta) return scelta.voto;
  }
  return null;
}

async function votoLetterboxd(tmdbId) {
  // Letterboxd ha un indirizzo che dall'id TMDB porta alla scheda del film.
  try {
    return leggiLetterboxd(await fetchText(`https://letterboxd.com/tmdb/${tmdbId}/`, { retries: 1 }));
  } catch (err) {
    if (err.status === 404) return null; // film non presente su Letterboxd
    throw err;
  }
}

/**
 * Sceglie il film giusto tra i risultati di TMDB, con prudenza: meglio nessun voto che il
 * voto di un altro film. Valgono solo i titoli uguali, oppure uno che inizia con l'altro e ne
 * copre almeno il 40% ("Avengers: Endgame Extra" -> "Avengers: Endgame", ma "Ultimo - Tutto:
 * Live a Tor Vergata" non diventa il film "Ultimo"). A parità vince il titolo esatto, poi il
 * film uscito negli ultimi due anni (quelli in sala), poi il più popolare.
 *
 * chiaveSenzaSottotitolo è la parte prima di " - " ("Pusher II - With Blood on My Hands" ->
 * "Pusher II"): vale come abbinamento parziale solo se ha almeno due parole, così "Ultimo"
 * da solo non basta mai.
 */
export function scegliMigliore(risultati, chiave, oggi, chiaveSenzaSottotitolo = null) {
  if (!Array.isArray(risultati) || !risultati.length || !chiave) return null;
  const breve =
    chiaveSenzaSottotitolo && chiaveSenzaSottotitolo !== chiave && chiaveSenzaSottotitolo.includes(' ')
      ? chiaveSenzaSottotitolo
      : null;
  const candidati = [];
  for (const r of risultati) {
    const chiavi = [chiaveTitolo(r.title), chiaveTitolo(r.original_title)].filter(Boolean);
    const esatto = chiavi.includes(chiave);
    const senzaSottotitolo = !esatto && Boolean(breve) && chiavi.includes(breve);
    const prefisso =
      !esatto &&
      chiavi.some((k) => {
        const [corta, lunga] = k.length < chiave.length ? [k, chiave] : [chiave, k];
        return corta.length >= 4 && lunga.startsWith(`${corta} `) && corta.length / lunga.length >= 0.4;
      });
    if (esatto || prefisso || senzaSottotitolo) candidati.push({ r, esatto });
  }
  if (!candidati.length) return null;

  const da = piuGiorni(oggi, -730);
  const a = piuGiorni(oggi, 365);
  const recente = (c) => Boolean(c.r.release_date && c.r.release_date >= da && c.r.release_date <= a);
  candidati.sort(
    (x, y) =>
      Number(y.esatto) - Number(x.esatto) ||
      Number(recente(y)) - Number(recente(x)) ||
      (y.r.popularity || 0) - (x.r.popularity || 0),
  );
  return candidati[0];
}

/** Ricerche da tentare in ordine: titolo intero, poi la parte prima di " - " e prima di ":". */
export function ricercheTmdb(titolo) {
  const base = titoloPulito(titolo);
  return unici([base, base.split(/\s[-–—]\s/)[0], base.split(':')[0]].map((q) => q.trim()).filter((q) => q.length >= 3));
}

/** Data di uscita italiana in sala dai release_dates di TMDB (sala > limitata > anteprima > digitale). */
export function uscitaItaliana(releaseDates) {
  const italia = (releaseDates?.results || []).find((r) => r.iso_3166_1 === 'IT');
  const perTipo = (tipo) =>
    (italia?.release_dates || [])
      .filter((r) => r.type === tipo && r.release_date)
      .map((r) => r.release_date.slice(0, 10))
      .sort()[0];
  return perTipo(3) || perTipo(2) || perTipo(1) || perTipo(4) || null;
}

/** Titolo inglese per Metacritic: la traduzione en-US di TMDB, altrimenti il titolo originale. */
export function titoloInglese(d) {
  const tr = (d?.translations?.translations || []).filter((t) => t.iso_639_1 === 'en' && t.data?.title);
  const us = tr.find((t) => t.iso_3166_1 === 'US') || tr[0];
  return us?.data?.title || (d?.original_language === 'en' ? d.original_title : null) || d?.original_title || null;
}

/** Uscita italiana, id IMDb e titolo inglese con una sola chiamata a TMDB. */
async function dettagliTmdb(id, key, ripiegoUscita) {
  try {
    const d = await fetchJson(`${TMDB}/movie/${id}?api_key=${key}&append_to_response=release_dates,external_ids,translations`);
    const imdbId = d.imdb_id || d.external_ids?.imdb_id || null;
    return {
      uscita: uscitaItaliana(d.release_dates) || ripiegoUscita || null,
      imdbId: /^tt\d+$/.test(imdbId || '') ? imdbId : null,
      titoloInglese: titoloInglese(d),
      titoloOriginale: d.original_title || null,
      uscitaMondo: d.release_date || null,
    };
  } catch {
    return { uscita: ripiegoUscita || null, imdbId: null, titoloInglese: null, titoloOriginale: null, uscitaMondo: ripiegoUscita || null };
  }
}

/** Episodi di una serie ("Un Prophète - ep. 1-4"): il voto del film omonimo sarebbe sbagliato. */
export function eSerieTv(titolo) {
  return /\b(ep|eps|episodio|episodi|puntata|puntate|stagione)\b\.?\s*\d/i.test(String(titolo || ''));
}

async function cercaSuTmdb(titolo, key, oggi) {
  const chiave = chiaveTitolo(titolo);
  const primaDelTrattino = titoloPulito(titolo).split(/\s[-–—]\s/)[0].trim();
  for (const query of ricercheTmdb(titolo)) {
    const dati = await fetchJson(
      `${TMDB}/search/movie?api_key=${key}&language=it-IT&region=IT&include_adult=false&query=${encodeURIComponent(query)}`,
    );
    const scelta = scegliMigliore(dati.results, chiave, oggi, query === primaDelTrattino ? chiaveTitolo(query) : null);
    if (!scelta) continue;
    const s = scelta.r;
    return {
      id: s.id,
      titolo: s.title || null,
      esatto: scelta.esatto,
      // w185: sul widget la locandina è larga ~70dp e la cache immagini non è persistente.
      poster: s.poster_path ? `https://image.tmdb.org/t/p/w185${s.poster_path}` : null,
      ...(await dettagliTmdb(s.id, key, s.release_date)),
    };
  }
  return { id: null };
}

/**
 * I voti che entrano nella media, tutti in decimi (null = non disponibile). TMDB serve solo
 * per riconoscere il film (locandina, date, collegamenti agli altri siti): il suo voto non conta.
 */
export function fontiVoto(e) {
  return {
    letterboxd: e?.letterboxd?.voto ?? null,
    imdb: e?.imdb?.voto ?? null,
    metacritic: e?.metacritic?.voto ?? null,
    mubi: e?.mubi?.voto ?? null,
  };
}

/**
 * Letterboxd e IMDb non hanno un'API pubblica: si leggono le loro pagine con calma.
 * Se una fonte fallisce tre volte di fila si smette di chiederle qualcosa per questo giro;
 * i voti mancanti verranno ripresi al giro successivo.
 */
function fonteEsterna(nome, pausaMs) {
  return { nome, pausaMs, trovati: 0, errori: 0, difila: 0, spenta: false, ultimoErrore: null };
}

async function chiedi(fonte, lavoro) {
  if (fonte.spenta) return undefined;
  if (fonte.pausaMs) await sleep(fonte.pausaMs);
  try {
    const risultato = await lavoro();
    fonte.difila = 0;
    return risultato;
  } catch (err) {
    fonte.errori++;
    fonte.difila++;
    fonte.ultimoErrore = err.message;
    if (fonte.difila >= 3) fonte.spenta = true;
    return undefined;
  }
}

async function arricchisci(titoli, oggi) {
  const avvisi = [];
  const mappa = new Map();
  const key = process.env.TMDB_API_KEY;
  const distinti = [...new Map(titoli.map((t) => [chiaveTitolo(t), t])).entries()].filter(([k]) => k);

  if (!key) {
    avvisi.push('Nessuna chiave TMDB: voti e date di uscita restano vuoti (le locandine arrivano dai siti delle sale)');
    return { mappa, avvisi, riepilogo: null };
  }

  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE, 'utf8'));
  } catch {
    /* prima esecuzione */
  }

  const adesso = Date.now();
  const giorni = (iso) => (adesso - Date.parse(iso)) / 86400000;
  const fresca = (e) =>
    e?.controllatoIl &&
    e.v === VERSIONE_CACHE &&
    'esatto' in e === Boolean(e.id) &&
    giorni(e.controllatoIl) < (e.id ? GIORNI_CACHE_TROVATO : GIORNI_CACHE_NON_TROVATO);
  const scaduto = (x) => !x?.il || giorni(x.il) >= GIORNI_CACHE_TROVATO;

  const letterboxd = fonteEsterna('Letterboxd', Number(process.env.PAUSA_LETTERBOXD_MS ?? 1000));
  const metacritic = fonteEsterna('Metacritic', Number(process.env.PAUSA_METACRITIC_MS ?? 1000));
  const mubi = fonteEsterna('MUBI', Number(process.env.PAUSA_MUBI_MS ?? 1000));
  const anno = (iso) => Number(String(iso || '').slice(0, 4)) || null;

  for (const [chiave, titolo] of distinti) {
    if (eSerieTv(titolo)) {
      delete cache[chiave];
      continue;
    }
    if (!fresca(cache[chiave])) {
      const vecchia = cache[chiave];
      try {
        const nuova = { ...(await cercaSuTmdb(titolo, key, oggi)), v: VERSIONE_CACHE, controllatoIl: new Date().toISOString() };
        // Stesso film di prima: i voti di Letterboxd e Metacritic restano validi fino alla loro scadenza.
        if (nuova.id && vecchia?.id === nuova.id) {
          if (vecchia.letterboxd) nuova.letterboxd = vecchia.letterboxd;
          if (vecchia.metacritic) nuova.metacritic = vecchia.metacritic;
          if (vecchia.mubi) nuova.mubi = vecchia.mubi;
          if (vecchia.imdb?.voti != null) nuova.imdb = vecchia.imdb;
        }
        cache[chiave] = nuova;
      } catch (err) {
        avvisi.push(`TMDB "${titolo}": ${err.message}`);
        continue;
      }
    }
    const e = cache[chiave];
    if (!e?.id) continue;

    if (scaduto(e.letterboxd)) {
      const voto = await chiedi(letterboxd, () => votoLetterboxd(e.id));
      if (voto !== undefined) e.letterboxd = { voto, il: new Date().toISOString() };
    }
    if (e.titoloInglese && scaduto(e.metacritic)) {
      const anni = unici([anno(e.uscitaMondo), anno(e.uscita)].filter(Boolean));
      const voto = await chiedi(metacritic, () => votoMetacritic(e.titoloInglese, anni));
      if (voto !== undefined) e.metacritic = { voto, il: new Date().toISOString() };
    }
    if ((e.titoloInglese || e.titoloOriginale) && scaduto(e.mubi)) {
      const anni = unici([anno(e.uscitaMondo), anno(e.uscita)].filter(Boolean));
      const titoli = [e.titoloInglese, e.titoloOriginale, e.titolo];
      const voto = await chiedi(mubi, () => votoMubi(titoli, anni));
      if (voto !== undefined) e.mubi = { voto, il: new Date().toISOString() };
    }
  }

  // IMDb: un solo download del dataset per tutti i film, a ogni giro (i voti cambiano ogni giorno).
  const conImdb = distinti.map(([k]) => cache[k]).filter((e) => e?.imdbId);
  if (conImdb.length) {
    try {
      const trovati = await votiImdb(conImdb.map((e) => e.imdbId));
      const il = new Date().toISOString();
      for (const e of conImdb) e.imdb = { ...(trovati.get(e.imdbId) || { voto: null, voti: 0 }), il };
    } catch (err) {
      avvisi.push(`IMDb: dataset non scaricato (${err.message}), restano i voti precedenti`);
    }
  }

  for (const fonte of [letterboxd, metacritic, mubi]) {
    if (fonte.errori) {
      avvisi.push(
        `${fonte.nome}: ${fonte.errori} richieste fallite (${fonte.ultimoErrore})${fonte.spenta ? ', sospesa per questo giro' : ''}`,
      );
    }
  }

  // Quanti film hanno un voto da ciascuna fonte: finisce in status.json per controllo.
  const riepilogo = { film: 0, letterboxd: 0, imdb: 0, metacritic: 0, mubi: 0, media: 0 };
  for (const [chiave] of distinti) {
    const e = cache[chiave];
    if (!e) continue;
    const fonti = fontiVoto(e);
    const voto = mediaVoti(fonti);
    mappa.set(chiave, { ...e, fonti, voto });
    riepilogo.film++;
    for (const [nome, v] of Object.entries(fonti)) if (v > 0) riepilogo[nome]++;
    if (voto != null) riepilogo.media++;
  }

  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return { mappa, avvisi, riepilogo };
}

/* ========================================== costruzione del JSON del widget == */

/**
 * Per ogni film, il titolo "scritto meglio" tra tutte le sale: l'Andromeda scrive tutto in
 * maiuscolo, UCI e Troisi di solito no. Si preferisce una versione con le minuscole.
 */
export function titoliMigliori(elenchiDiFilm) {
  const migliori = new Map();
  for (const film of elenchiDiFilm.flat()) {
    const pulito = titoloPulito(film.titolo);
    const chiave = chiaveTitolo(film.titolo);
    if (!chiave || !pulito) continue;
    const attuale = migliori.get(chiave);
    const haMinuscole = /\p{Ll}/u.test(pulito);
    if (!attuale || (haMinuscole && !/\p{Ll}/u.test(attuale))) migliori.set(chiave, pulito);
  }
  return migliori;
}

function titoloDaMostrare(raw, info, titoli) {
  // Il titolo di TMDB solo se l'abbinamento è esatto: "Avengers: Endgame Extra" resta com'è.
  const tmdb = info?.esatto ? info.titolo : null;
  const base = (tmdb || capitalizza(titoli?.get(chiaveTitolo(raw)) || titoloPulito(raw)) || raw).trim();
  if (!inLinguaOriginale(raw)) return base;
  return /\bv\.?\s?o\.?/i.test(base) ? base : `${base} (V.O.)`;
}

/**
 * Unisce le schede dello stesso film (l'Andromeda, per esempio, ne ha una normale e una
 * per la promo "Cinema in Festa"). La versione originale resta separata: è un'altra
 * proiezione e interessa distinguerla.
 */
export function unisciDoppioni(film) {
  const perChiave = new Map();
  for (const f of film) {
    const chiave = `${chiaveTitolo(f.titolo)}|${inLinguaOriginale(f.titolo) ? 'vo' : 'it'}`;
    const esistente = perChiave.get(chiave);
    if (!esistente) {
      perChiave.set(chiave, { ...f, proiezioni: [...f.proiezioni] });
      continue;
    }
    esistente.proiezioni.push(...f.proiezioni);
    esistente.poster ||= f.poster;
    // Tra due titoli equivalenti si tiene il più pulito (senza "cinema in festa", durate…).
    if (f.titolo.length < esistente.titolo.length) esistente.titolo = f.titolo;
  }
  return [...perChiave.values()];
}

/** Valori più alti prima, null sempre in fondo (vale per numeri e date ISO). */
export function discendente(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a > b ? -1 : a < b ? 1 : 0;
}

const perVoto = (x, y) => discendente(x.rating, y.rating) || discendente(x.releaseDate, y.releaseDate) || x.title.localeCompare(y.title, 'it');
const perUscita = (x, y) => discendente(x.releaseDate, y.releaseDate) || discendente(x.rating, y.rating) || x.title.localeCompare(y.title, 'it');

/**
 * Punteggio SMART di un film in un giorno, da 0 a 100. Tre criteri, ciascuno da 0 a 1:
 *   voto         la media dei voti: 5 o meno vale 0, 8.5 o più vale 1 (in mezzo in proporzione)
 *   novità       1 se esce oggi o deve ancora uscire, poi si dimezza ogni 21 giorni
 *   spettacoli   spettacoli del film quel giorno diviso quelli del film più programmato
 *                in quella sala quel giorno
 * Il voto pesa 1,5 volte gli altri due. Voto o data mancanti valgono 0,5 (né premio né castigo).
 */
export function punteggioSmart({ voto, uscita, spettacoli, massimo }, oggi) {
  const tra01 = (n) => Math.min(1, Math.max(0, n));
  const v = Number.isFinite(voto) && voto > 0 ? tra01((voto - 5) / 3.5) : 0.5;
  let u = 0.5;
  if (uscita) {
    const passati = giorniTra(uscita, oggi);
    u = passati <= 0 ? 1 : 0.5 ** (passati / 21);
  }
  const s = massimo > 0 ? tra01(spettacoli / massimo) : 0;
  return Math.round((100 * (1.5 * v + u + s)) / 3.5);
}

/**
 * Per ogni film, calcolato qui una volta per tutte:
 *   rankVoto    posizione per voto medio dal più alto, a parità uscita più recente
 *   rankUscita  posizione per uscita in Italia dalla più recente, a parità voto più alto
 *   smart       punteggio SMART per ciascun giorno di programmazione ({"2026-09-23": 78, …})
 * Il widget raggruppa per giorno e dentro ogni giorno ordina con uno dei tre.
 * L'array arriva già ordinato per rankVoto.
 */
export function costruisciFeed(film, { oggi, info = new Map(), titoli = new Map(), scalaVoto = 10, giorni = GIORNI } = {}) {
  const ammesse = new Set(intervallo(oggi, giorni));
  const voci = [];
  const votiInDecimi = new Map(); // il voto su 10 anche se il feed è su 5

  for (const f of unisciDoppioni(film)) {
    const grezzo = {};
    for (const { data, ora } of f.proiezioni) {
      if (!ammesse.has(data)) continue;
      (grezzo[data] ||= []).push(ora);
    }
    // Giorni in ordine di data e orari in ordine crescente: il widget può fidarsi del primo.
    const date = Object.keys(grezzo).sort();
    if (!date.length) continue;
    const perGiorno = Object.fromEntries(date.map((d) => [d, unici(grezzo[d]).sort()]));

    const dati = info.get(chiaveTitolo(f.titolo));
    // Se oggi non proietta, si mostra il primo giorno utile dichiarandolo.
    const giornoMostrato = perGiorno[oggi]?.length ? oggi : date[0];
    const voto = Number.isFinite(dati?.voto) ? dati.voto : null;
    const rating = voto == null ? null : arrotonda1(scalaVoto === 5 ? voto / 2 : voto);
    // Locandina: quella di TMDB se il film è proprio quello, altrimenti quella della sala
    // (per riedizioni ed eventi è la locandina giusta).
    const poster = dati?.esatto ? dati.poster || f.poster : f.poster || dati?.poster;

    voci.push({
      title: titoloDaMostrare(f.titolo, dati, titoli),
      poster: poster || null,
      rating,
      ratings: dati?.fonti || { letterboxd: null, imdb: null, metacritic: null, mubi: null },
      releaseDate: dati?.uscita || null,
      showtimes: perGiorno[giornoMostrato],
      showtimesDate: giornoMostrato,
      days: perGiorno,
      room: f.proiezioni.find((p) => p.data === giornoMostrato)?.sala || null,
      vo: inLinguaOriginale(f.titolo),
      url: f.link || null,
    });
    votiInDecimi.set(voci.at(-1), voto);
  }

  // SMART: gli spettacoli si confrontano con il film più programmato di quel giorno.
  const massimoDelGiorno = {};
  for (const v of voci) {
    for (const [d, orari] of Object.entries(v.days)) massimoDelGiorno[d] = Math.max(massimoDelGiorno[d] || 0, orari.length);
  }
  for (const v of voci) {
    v.smart = Object.fromEntries(
      Object.entries(v.days).map(([d, orari]) => [
        d,
        punteggioSmart({ voto: votiInDecimi.get(v), uscita: v.releaseDate, spettacoli: orari.length, massimo: massimoDelGiorno[d] }, oggi),
      ]),
    );
  }

  [...voci].sort(perUscita).forEach((v, i) => {
    v.rankUscita = i;
  });
  voci.sort(perVoto).forEach((v, i) => {
    v.rankVoto = i;
  });
  return voci;
}

/* ================================================================= pagina == */

function paginaStato(stato) {
  const righe = stato.feeds
    .map(
      (f) => `      <tr>
        <td><strong>${f.label}</strong><br><span class="muted">${f.cinema}</span></td>
        <td class="num">${f.count}</td>
        <td><span class="pill ${f.state}">${f.state === 'ok' ? 'aggiornato' : f.state === 'stale' ? 'non aggiornato' : 'vuoto'}</span></td>
        <td><code>${f.url}</code></td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feed Cinema Roma</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e4e4e4; --ok:#1a7f37; --warn:#9a6700; --err:#b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b0b0b; --fg:#ededed; --muted:#8d8d8d; --line:#242424; --ok:#4ac26b; --warn:#d4a72c; --err:#ff6b5e; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 16px; background:var(--bg); color:var(--fg);
         font-family:ui-monospace,SFMono-Regular,Menlo,monospace; line-height:1.5; }
  main { max-width:820px; margin:0 auto; }
  h1 { font-size:1.25rem; letter-spacing:.14em; text-transform:uppercase; margin:0 0 4px; }
  .muted { color:var(--muted); font-size:.8rem; }
  table { width:100%; border-collapse:collapse; margin-top:24px; }
  th,td { text-align:left; padding:12px 8px; border-bottom:1px solid var(--line); vertical-align:top; font-size:.82rem; }
  th { font-size:.7rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  .num { font-variant-numeric:tabular-nums; }
  code { font-size:.75rem; word-break:break-all; }
  .pill { font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; padding:2px 8px; border:1px solid currentColor; border-radius:999px; }
  .ok { color:var(--ok); } .stale { color:var(--warn); } .empty { color:var(--err); }
  ul { padding-left:18px; }
</style>
</head>
<body>
<main>
  <h1>Feed Cinema Roma</h1>
  <p class="muted">Ultimo aggiornamento ${stato.updatedAt} · giorno di riferimento ${stato.today} · voti su scala 0–${stato.ratingScale}</p>
  <p class="muted">Il widget legge <code>${stato.widgetUrl}</code></p>
  <table>
    <thead><tr><th>Sala</th><th>Film</th><th>Stato</th><th>Feed della singola sala</th></tr></thead>
    <tbody>
${righe}
    </tbody>
  </table>
  ${
    stato.warnings.length
      ? `<p class="muted" style="margin-top:24px">Segnalazioni dell'ultimo giro:</p><ul class="muted">${stato.warnings
          .map((w) => `<li>${w.replace(/</g, '&lt;')}</li>`)
          .join('')}</ul>`
      : ''
  }
</main>
</body>
</html>
`;
}

/* =================================================================== main == */

const SALE = [
  { key: 'porta', label: 'PORTA', cinema: 'UCI Cinemas Porta di Roma', scarica: (oggi) => scaricaPorta(oggi) },
  { key: 'troisi', label: 'TROISI', cinema: 'Cinema Troisi', scarica: (oggi) => scaricaTroisi(oggi) },
  { key: 'andromeda', label: 'ANDROMEDA', cinema: 'Multisala Andromeda', scarica: () => scaricaAndromeda() },
];

async function main() {
  const oggi = oggiRoma();
  const base = (process.env.FEED_BASE_URL || '').replace(/\/$/, '');
  console.log(`Giorno di riferimento (Roma): ${oggi}`);

  const risultati = await Promise.all(
    SALE.map(async (sala) => {
      try {
        const r = await sala.scarica(oggi);
        console.log(`${sala.label}: ${r.film.length} film`);
        return { sala, ...r };
      } catch (err) {
        console.error(`${sala.label}: errore — ${err.message}`);
        return { sala, film: [], avvisi: [`${sala.label}: ${err.message}`] };
      }
    }),
  );

  const { mappa: info, avvisi: avvisiTmdb, riepilogo } = await arricchisci(risultati.flatMap((r) => r.film.map((f) => f.titolo)), oggi);

  const titoli = titoliMigliori(risultati.map((r) => r.film));
  const avvisi = [...avvisiTmdb];
  const feeds = [];
  const perSala = {};
  let tuttoVuoto = true;

  await mkdir(DOCS, { recursive: true });
  // debug/ contiene solo l'HTML delle sale fallite in QUESTO giro: serve a capire cosa
  // è cambiato sul sito. Non viene pubblicato (Pages pubblica solo docs/).
  await rm(DEBUG, { recursive: true, force: true });

  for (const r of risultati) {
    avvisi.push(...(r.avvisi || []));
    if (r.grezzo) {
      await mkdir(DEBUG, { recursive: true });
      await writeFile(join(DEBUG, `${r.sala.key}.html`), r.grezzo, 'utf8');
    }
    const voci = costruisciFeed(r.film, { oggi, info, titoli, scalaVoto: RATING_SCALE });
    const percorso = join(DOCS, `${r.sala.key}.json`);

    let pubblicato = voci;
    let stato = 'ok';

    if (!voci.length) {
      // Mai sovrascrivere un feed buono con una lista vuota.
      let precedente = [];
      try {
        precedente = JSON.parse(await readFile(percorso, 'utf8'));
      } catch {
        /* non esisteva */
      }
      if (Array.isArray(precedente) && precedente.length) {
        pubblicato = precedente;
        stato = 'stale';
        avvisi.push(`${r.sala.label}: nessun dato nuovo, resta pubblicato il precedente (${precedente.length} film)`);
      } else {
        stato = 'empty';
      }
    }

    if (pubblicato.length) tuttoVuoto = false;
    perSala[r.sala.key] = pubblicato;
    await writeFile(percorso, `${JSON.stringify(pubblicato, null, 2)}\n`, 'utf8');

    feeds.push({
      key: r.sala.key,
      label: r.sala.label,
      cinema: r.sala.cinema,
      count: pubblicato.length,
      state: stato,
      url: base ? `${base}/${r.sala.key}.json` : `${r.sala.key}.json`,
    });
  }

  const stato = {
    updatedAt: new Date().toISOString(),
    today: oggi,
    ratingScale: RATING_SCALE,
    ratingSources: riepilogo,
    widgetUrl: base ? `${base}/cinema.json` : 'cinema.json',
    feeds,
    warnings: avvisi,
  };

  // Il file che legge il widget: tutte e tre le sale in una sola richiesta.
  const cinema = { updatedAt: stato.updatedAt, cinemas: perSala };
  await writeFile(join(DOCS, 'cinema.json'), `${JSON.stringify(cinema)}\n`, 'utf8');
  await writeFile(join(DOCS, 'status.json'), `${JSON.stringify(stato, null, 2)}\n`, 'utf8');
  await writeFile(join(DOCS, 'index.html'), paginaStato(stato), 'utf8');
  await writeFile(join(DOCS, '.nojekyll'), '', 'utf8');

  console.log(feeds.map((f) => `${f.label} ${f.count} (${f.state})`).join(' · '));
  if (avvisi.length) console.log(`\nSegnalazioni:\n${avvisi.map((a) => ` - ${a}`).join('\n')}`);

  if (tuttoVuoto) {
    console.error('Nessuna sala ha prodotto dati.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
