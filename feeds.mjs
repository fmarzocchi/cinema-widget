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

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS = join(ROOT, 'docs');
const DEBUG = join(ROOT, 'debug');
const CACHE = join(ROOT, 'cache', 'tmdb.json');

const RATING_SCALE = Number(process.env.RATING_SCALE || 5); // 5 = voti tipo 3.8, 10 = voti tipo 7.6
const GIORNI = 7; // quanti giorni di programmazione raccogliere

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ========================================================== utility base == */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { retries = 3, timeoutMs = 20000, accept } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'it-IT,it;q=0.9',
          ...(accept ? { Accept: accept } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        // "Troppe richieste": si aspetta sul serio (Retry-After se c'è, altrimenti 20s, 40s, 60s…).
        const dopo = Number(res.headers.get('retry-after'));
        const err = new Error('HTTP 429 (troppe richieste)');
        err.attesa = Number.isFinite(dopo) && dopo > 0 ? dopo * 1000 : 20000 * (attempt + 1);
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
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

/* ===================================== locandine, voti e date (TMDB, opz.) == */

const TMDB = 'https://api.themoviedb.org/3';
const GIORNI_CACHE_TROVATO = 30;
const GIORNI_CACHE_NON_TROVATO = 3;

function scegliMigliore(risultati, chiave) {
  if (!risultati?.length) return null;
  return (
    risultati.find((r) => chiaveTitolo(r.title) === chiave || chiaveTitolo(r.original_title) === chiave) ||
    risultati.find((r) => chiaveTitolo(r.title).startsWith(chiave)) ||
    [...risultati].sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0]
  );
}

/** Data di uscita italiana in sala; se manca, quella globale di TMDB. */
async function uscitaItaliana(id, key, ripiego) {
  try {
    const dati = await fetchJson(`${TMDB}/movie/${id}/release_dates?api_key=${key}`);
    const italia = (dati.results || []).find((r) => r.iso_3166_1 === 'IT');
    if (italia?.release_dates?.length) {
      const perTipo = (tipo) =>
        italia.release_dates
          .filter((r) => r.type === tipo && r.release_date)
          .map((r) => r.release_date.slice(0, 10))
          .sort()[0];
      const trovata = perTipo(3) || perTipo(2) || perTipo(1) || perTipo(4);
      if (trovata) return trovata;
    }
  } catch {
    /* si usa il ripiego */
  }
  return ripiego || null;
}

async function cercaSuTmdb(titolo, key) {
  const query = titoloPulito(titolo);
  if (!query) return { id: null };
  const dati = await fetchJson(
    `${TMDB}/search/movie?api_key=${key}&language=it-IT&region=IT&include_adult=false&query=${encodeURIComponent(query)}`,
  );
  const scelto = scegliMigliore(dati.results, chiaveTitolo(titolo));
  if (!scelto) return { id: null };
  return {
    id: scelto.id,
    titolo: scelto.title || null,
    // w185: sul widget la locandina è larga ~70dp e la cache immagini non è persistente,
    // quindi conviene un file leggero che si riscarica in fretta.
    poster: scelto.poster_path ? `https://image.tmdb.org/t/p/w185${scelto.poster_path}` : null,
    voto: Number.isFinite(scelto.vote_average) && scelto.vote_count > 0 ? scelto.vote_average : null,
    uscita: await uscitaItaliana(scelto.id, key, scelto.release_date),
  };
}

async function arricchisci(titoli) {
  const avvisi = [];
  const mappa = new Map();
  const key = process.env.TMDB_API_KEY;
  const distinti = [...new Map(titoli.map((t) => [chiaveTitolo(t), t])).entries()].filter(([k]) => k);

  if (!key) {
    avvisi.push('Nessuna chiave TMDB: voti e date di uscita restano vuoti (le locandine arrivano dai siti delle sale)');
    return { mappa, avvisi };
  }

  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE, 'utf8'));
  } catch {
    /* prima esecuzione */
  }

  const adesso = Date.now();
  const fresca = (e) =>
    e?.controllatoIl &&
    adesso - Date.parse(e.controllatoIl) < (e.id ? GIORNI_CACHE_TROVATO : GIORNI_CACHE_NON_TROVATO) * 86400000;

  for (const [chiave, titolo] of distinti) {
    if (fresca(cache[chiave])) continue;
    try {
      cache[chiave] = { ...(await cercaSuTmdb(titolo, key)), controllatoIl: new Date().toISOString() };
    } catch (err) {
      avvisi.push(`TMDB "${titolo}": ${err.message}`);
    }
  }

  for (const [chiave] of distinti) if (cache[chiave]) mappa.set(chiave, cache[chiave]);

  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return { mappa, avvisi };
}

/* ========================================== costruzione del JSON del widget == */

/**
 * Punteggio "smart" 0–1: 60% voto, 40% novità (un film perde freschezza in 60 giorni).
 * Sta qui e non nel widget: cambiare la formula costa una riga qui, mentre ogni
 * modifica al widget costa un giro di iterazioni con l'AI di Essential Apps.
 */
export function punteggio({ rating, releaseDate }, oggi, scalaVoto = 5) {
  const voto = Number.isFinite(rating) ? Math.min(1, Math.max(0, rating / scalaVoto)) : 0.5;
  let novita = 0.5;
  if (releaseDate) {
    const giorni = Math.round((Date.parse(oggi) - Date.parse(releaseDate)) / 86400000);
    if (Number.isFinite(giorni)) novita = giorni < 0 ? 1 : Math.max(0, 1 - giorni / 60);
  }
  return Math.round((0.6 * voto + 0.4 * novita) * 1000) / 1000;
}

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
  const base = (info?.titolo || capitalizza(titoli?.get(chiaveTitolo(raw)) || titoloPulito(raw)) || raw).trim();
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

export function costruisciFeed(film, { oggi, info = new Map(), titoli = new Map(), scalaVoto = 5, giorni = GIORNI } = {}) {
  const ammesse = new Set(intervallo(oggi, giorni));
  const voci = [];

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
    const voto = dati?.voto;

    const rating = Number.isFinite(voto) ? Math.round((scalaVoto === 10 ? voto : voto / 2) * 10) / 10 : null;
    const releaseDate = dati?.uscita || null;

    voci.push({
      title: titoloDaMostrare(f.titolo, dati, titoli),
      poster: dati?.poster || f.poster || null,
      rating,
      releaseDate,
      score: punteggio({ rating, releaseDate }, oggi, scalaVoto),
      showtimes: perGiorno[giornoMostrato],
      showtimesDate: giornoMostrato,
      days: perGiorno,
      room: f.proiezioni.find((p) => p.data === giornoMostrato)?.sala || null,
      vo: inLinguaOriginale(f.titolo),
      url: f.link || null,
    });
  }

  // Ordine di default = ordine "smart": prima chi proietta oggi, poi per punteggio.
  // Così anche un widget che non riordina nulla mostra la lista giusta.
  voci.sort((a, b) => {
    const ax = a.showtimesDate === oggi ? 0 : 1;
    const bx = b.showtimesDate === oggi ? 0 : 1;
    if (ax !== bx) return ax - bx;
    if (ax === 1 && a.showtimesDate !== b.showtimesDate) return a.showtimesDate < b.showtimesDate ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.title.localeCompare(b.title, 'it');
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

  const { mappa: info, avvisi: avvisiTmdb } = await arricchisci(risultati.flatMap((r) => r.film.map((f) => f.titolo)));

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
