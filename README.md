# cinema-widget

Programmazione di tre sale di Roma, pronta per il widget "Cinema Roma" di Nothing OS (Essential Apps).

| Sala | Fonte |
| --- | --- |
| UCI Cinemas Porta di Roma | API JSON del sito UCI |
| Cinema Troisi | pagina settimanale Liveticket |
| Multisala Andromeda | schede film 18tickets |

Quattro volte al giorno (06, 12, 18, 24 ora italiana) il workflow `Aggiorna feed cinema` esegue `feeds.mjs` e pubblica su GitHub Pages:

- **`cinema.json`** — le tre sale insieme: è il file che legge il widget
- `porta.json`, `troisi.json`, `andromeda.json` — le singole sale
- `index.html` — pagina di controllo: quanti film per sala e gli eventuali avvisi

Se una sala non risponde, resta pubblicato il suo ultimo feed buono e l'HTML ricevuto finisce in `debug/`.

Il secret `TMDB_API_KEY` (chiave gratuita di themoviedb.org) aggiunge date di uscita italiane, locandine migliori e i voti.

## Voti

`rating` è la media dei voti disponibili, in decimi, di quattro fonti: TMDB e IMDb (utenti), Letterboxd (cinefili) e Metacritic (critica, letto da IMDb). Una fonte senza voto o con 0 non entra nella media; se non ce n'è nessuna `rating` è `null` e il widget scrive "n.a.". I singoli voti sono in `ratings`. Letterboxd e IMDb non hanno un'API pubblica: se non rispondono, la media usa le fonti rimaste e il riepilogo è in `status.json` (`ratingSources`).

## Ordinamenti

Ogni film porta `rankVoto`, `rankUscita` e `smart`, un punteggio 0–100 per ogni giorno di programmazione. SMART combina voto (peso 1,5), novità (dimezza ogni 21 giorni dall'uscita) e spettacoli del giorno rispetto al film più programmato in quella sala. Il widget raggruppa i film per giorno e dentro ogni giorno ordina con uno dei tre.
