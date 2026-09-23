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

Facoltativo: un secret `TMDB_API_KEY` (chiave gratuita di themoviedb.org) aggiunge voti, date di uscita e locandine migliori.
