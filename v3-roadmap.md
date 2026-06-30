# MatchPredictor v3 — Roadmap "email-first"

> Documento di pianificazione per la prossima evoluzione del progetto, da riprendere
> dopo la fine del Mondiale 2026 attuale. Nessuna di queste modifiche tocca il sito
> live in produzione (contratto v1, `0x8a0102d262fB37B39cDF5bB8A3935Ba9E4f15797`).

## Filosofia del prodotto

Gioco di pronostici **solo per intrattenimento**, nessun valore economico reale
(per restare fuori dal perimetro legale del gioco d'azzardo). Accesso
**esclusivamente via email** — nessun wallet, nessuna estensione browser, nessun
gas da gestire lato utente. Obiettivo: massima semplicità, specialmente da mobile
(elimina il problema sperimentato con l'app UP mobile e il passaggio scomodo via
Blockscout per accedere al browser integrato).

Collegamento opzionale a una Universal Profile esistente, solo per chi lo desidera
(per ricevere gli NFT vinti direttamente lì, o per spostarli successivamente).

## Architettura smart contract

### Ruoli (3 chiavi separate — principio di minimo privilegio)

| Ruolo | Responsabilità |
|---|---|
| `owner` | Universal Profile reale. Gestione collezione, creazione partite, rotazione chiavi |
| `oracle` | EOA dedicata. Solo `reportResult()` |
| `sponsor` | EOA dedicata. Solo `predictFor()` / `predictBatchFor()` / `claimFor()` — paga il gas per conto di tutti gli utenti registrati via email |

Separazione deliberata: se una chiave fosse compromessa, il danno resta
circoscritto al suo ruolo specifico.

### Funzioni principali

```solidity
// Owner — creazione partite
function createMatch(string teamHome, string teamAway, uint256 deadline) external onlyOwner returns (uint256);
function createMatchBatch(string[] teamHomes, string[] teamAways, uint256[] deadlines) external onlyOwner returns (uint256[] memory);

// Sponsor — pronostici e claim "per conto di"
function predictFor(uint256 matchId, Result result, address predictor) external onlySponsor;
function predictBatchFor(uint256[] matchIds, Result[] results, address predictor) external onlySponsor;
// Nota: un solo predictor per chiamata batch — raggruppa i pronostici di UN
// utente su più partite, non mescola pronostici di utenti diversi.
function claimFor(uint256 matchId, address winner) external onlySponsor;

// Oracle — risoluzione risultati (invariato dalla v1/v2)
function reportResult(uint256 matchId, Result actualResult) external onlyOracle;
```

**Eliminate rispetto alla v1**: `predict()` e `claim()` ad accesso diretto.
Nessun utente firma mai direttamente una transazione — modo univoco via email,
come da decisione esplicita.

### Già pronto da lavoro precedente (contratto v2 in `contracts/MatchPredictor-v2.sol`)

- `LSP4TokenType` corretto a `1` (NFT) — fix bug visibilità wallet UP
- Token story on-chain per-token: al momento del claim, scrive on-chain la
  stringa `"matchId|teamHome|teamAway|result"` sotto chiave dati custom
  (`TOKEN_STORY_KEY`), leggibile da chiunque senza dipendenze IPFS

## Backend (ricostruzione sostanziale)

### Gestione utenti
- Tabella utenti: email, indirizzo associato, chiave privata cifrata
  (solo se EOA generata — nessuna chiave da custodire se l'utente collega
  direttamente una UP esistente)
- **Autenticazione: magic link via email** (passwordless)
- Generazione EOA dedicata alla registrazione, se l'utente non collega subito una UP

### Import partite — rivisto per volumi alti (campionati aperti)
- Recupero da football-data.org di **tutte** le partite della finestra di date
  (potenzialmente centinaia con campionati nazionali attivi in parallelo)
- Frontend admin: lista **selezionabile** (checkbox) — l'owner sceglie quali
  proporre, non più "importa tutto automaticamente"
- Creazione selezionate in un'unica `createMatchBatch()`

### Trasferimento manuale EOA → UP
- L'utente con NFT su un indirizzo email-generato può richiedere lo spostamento
  verso una UP di sua scelta
- Gestito **manualmente**: il backend firma `transfer()` su LSP8 usando la
  chiave custodita di quello specifico utente, su richiesta esplicita
  (non automatico, per evitare il problema "ogni EOA deve avere fondi propri
  per pagare gas" — qui paga sempre lo sponsor anche per il transfer)

## Frontend (ricostruito)

- Nessuna connessione UP richiesta per giocare — solo email
- Collegamento UP opzionale, in qualsiasi momento
- Stesse funzionalità di visualizzazione già consolidate: punteggio esatto,
  conteggio predizioni, lista vincitori, classifica globale
- Toggle semplice partite giocate / da giocare (decisione presa, da
  implementare insieme al resto)
- Pagina dedicata `/my-predictions` (area riservata, decisione presa)
- Pannello admin: selezione partite da importare, gestione richieste di
  trasferimento

## Sostenibilità economica (da esplorare, non urgente)

Se il progetto crescesse oltre la fase sperimentale e i volumi di transazioni
sponsorizzate diventassero significativi: possibilità di accettare donazioni
volontarie in LYX da chi gioca, per alimentare il wallet sponsor e sostenere
collettivamente le fee di transazione di tutti gli utenti. Da progettare con
calma solo se/quando diventa un problema reale di sostenibilità.

## Punti ancora aperti

1. **Sicurezza del backend**: cifratura chiavi private, gestione accessi al
   database, strategia di backup — da progettare con cura, essendo ora il
   backend il vero custode di fondi/identità per conto di terzi (anche se
   senza valore economico reale, resta una responsabilità da trattare
   seriamente)
2. **Stima costi gas reali** a volumi più alti (centinaia di utenti/partite),
   da fare quando si avvicina il momento di costruire — per ora si resta su
   LUKSO testnet, dove il gas è gratuito/sponsorizzato dalla rete stessa
