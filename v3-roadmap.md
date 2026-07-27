# MatchPredictor v3 — Stato del progetto (post-lancio mainnet)

> Aggiornamento del documento di pianificazione originale ("email-first roadmap").
> La maggior parte di quanto pianificato è stata costruita e **il sito è live su
> LUKSO Mainnet**. Questo documento riflette lo stato reale, non più solo le
> intenzioni.

## Stato attuale in breve

- **Live su LUKSO Mainnet** (non più solo testnet)
- Contratto: `MatchPredictor-main-v1.sol`, indirizzo `0xf3D944E7061E896352C9082fe7866Ddbd436398d`
- Owner: UP ChainIntegrate (`0x4a2605796e0d91A9667d6E30365aEEC384C48c27`)
- Sito: `playmatchpredictor.chainintegrate.it`
- Copertura: **6 campionati** (non più solo il Mondiale) — Serie A, Premier
  League, Bundesliga, La Liga, Ligue 1, Eredivisie
- Prima transazione reale confermata funzionante (pronostico con LYX vero)
- Listato nello **UP! Store** di LUKSO (categoria Gaming/NFTs)

## Filosofia del prodotto (confermata, invariata nel principio)

Gioco di pronostici **solo per intrattenimento**, nessun valore economico
reale in ingresso (si resta fuori dal perimetro del gioco d'azzardo — nessuna
puntata, il premio è un NFT che certifica un pronostico corretto, non vinto
scommettendo denaro). Accesso **esclusivamente via email** (magic link),
nessun wallet richiesto per giocare. Collegamento opzionale a una Universal
Profile esistente in fase di registrazione, per chi la possiede già.

**Evoluzione rispetto al piano originale**: non più legato a un singolo evento
(Mondiale), ma a più campionati in corso contemporaneamente, con iscrizione
esplicita per competizione (max 2 alla volta, override possibile per singolo
utente dal pannello admin).

## Architettura smart contract

### Ruoli (invariati nel principio, confermati in produzione)

| Ruolo | Responsabilità |
|---|---|
| `owner` | UP ChainIntegrate. Metadata, creazione partite, rotazione chiavi |
| `oracle` | EOA dedicata. Solo `reportResult()` — automatizzata via cron ogni 30 minuti |
| `sponsor` | EOA dedicata. `predictFor()` / `predictBatchFor()` / `claimFor()` — paga il gas per tutti gli utenti |

### Corretto rispetto alla v3 originale (revisione di sicurezza pre-mainnet)

- **`reportResult()`** ora richiede che la deadline sia passata prima di
  accettare un risultato (`PredictionWindowStillOpen` se troppo presto) —
  altrimenti si apriva una finestra teorica in cui si poteva pronosticare
  conoscendo già l'esito, se l'oracolo avesse mai riportato in anticipo
- **`predictFor()`** controlla esplicitamente anche `m.resolved`, non solo la
  deadline — seconda linea di difesa indipendente
- **`claimForBatch()`** (lato oracolo, non nel contratto): assegna premi a più
  vincitori **in parallelo** invece che in sequenza, con gestione esplicita
  dei nonce — una partita popolare con centinaia di vincitori non fa più
  rischiare che un giro dell'oracolo superi i 30 minuti tra un cron e l'altro
- **Lock file** sull'oracolo: impedisce a due giri di sovrapporsi se uno
  impiega più del previsto

Il contratto è **verificato su Blockscout mainnet**, codice sorgente e ABI
leggibili pubblicamente.

## Multi-competizione (non previsto nel piano originale, costruito dopo)

- Import da football-data.org per singola competizione scelta dal pannello
  admin, non più solo Mondiale
- **Iscrizione esplicita richiesta** prima di poter pronosticare su una lega
  (come i gruppi) — max 2 competizioni contemporanee per utente, override
  per singolo utente gestibile dal pannello admin senza toccare codice
- Metadata NFT per singolo token: competizione letta **dinamicamente** dalla
  partita reale (bug corretto: prima riportava sempre "FIFA World Cup 2026"
  a prescindere dalla lega vera)

## Gruppi (non previsto nel piano originale, costruito dopo)

- Creazione gruppo **scoped a una sola competizione** (richiede iscrizione a
  quella lega), non più selezione libera tra tutte le partite esistenti
- Esclude automaticamente partite già giocate e di altre leghe
- Max 3 gruppi creati, max 5 a cui partecipare — override per-utente come le
  competizioni
- Congelamento gruppo (classifica finale fissata) tramite `frozen_match_ids`

## Backend

Confermato dal piano originale: autenticazione via magic link, EOA generata
automaticamente se l'utente non collega una UP propria, cifratura chiavi
private (AES-256-GCM).

**Aggiunte rispetto al piano**:
- Rate-limit e override per-utente su gruppi e competizioni (tabella
  `users` con colonne `max_groups_created`, `max_groups_joined`,
  `max_competitions_joined`, NULL = usa il default globale)
- Notifica email opt-in su nuove partite pubblicate
- Aggiornamento mirato della singola card dopo un pronostico invece di
  ricaricare l'intera lega (riduce drasticamente le richieste RPC)

## Infrastruttura RPC (capitolo interamente nuovo, non nel piano originale)

Il piano originale non prevedeva questo problema perché su testnet il nodo
pubblico ufficiale era sufficiente all'epoca. In pratica:

1. **RPC pubblico LUKSO** → inaffidabile, cadute frequenti
2. **Blockscout** (proxy RPC di un explorer, non pensato per quell'uso) →
   soluzione tampone, ~4% di fallimenti misurati sull'oracolo in produzione
3. **Migrazione a thirdweb** (piano gratuito) → 0% di fallimenti su un
   campione di 30+ giri consecutivi
4. **Limite reale scoperto**: 10 richieste/secondo (non i 25 dichiarati nella
   documentazione generale) — richiesto un giro di ottimizzazione (fetch
   collettivo pronostici invece che per-partita, raggruppamento HTTP
   corretto, concorrenza ridotta a 8)
5. **Valutato e scartato** un piano a pagamento SigmaCore (nodo dedicato,
   €50-100/mese) — sproporzionato per un progetto gratuito e non commerciale
6. **Gestione proprio nodo** valutata e scartata — carico operativo non
   sostenibile per un solo sviluppatore con altri progetti in parallelo

## Pannello admin (evoluto rispetto al piano originale)

- Import selezionabile confermato come da piano
- **Rimossa** la sezione "Test sponsor/oracle functions" (chiavi private
  incollabili in un form web) — rischio di sicurezza reale su mainnet, mai
  stata pensata per la produzione
- **Rimossa** "Create single match" (superata dall'import in blocco)
- **Aggiunta** visualizzazione saldi sponsor/oracolo, letti live dal
  contratto (`sponsor()`/`oracle()`), non più solo via script da riga di
  comando
- **Aggiunta** gestione override limiti per utente (gruppi/competizioni),
  tabella editabile invece di comandi SQL manuali
- Responsive per browser in-app del wallet (schede impilate sotto 640px)

## Sostenibilità economica — risolto, non più "da esplorare"

Il piano originale lo segnava come "da progettare con calma se diventa un
problema". Con i dati reali in mano: **non lo è**. A prezzi/gas attuali,
anche uno scenario con centinaia di utenti attivi costa nell'ordine di pochi
centesimi a settimana — il vero collo di bottiglia era ed è l'affidabilità
RPC, non il costo del gas. Nessuna donazione o meccanismo di sostenibilità
economica risulta necessario allo stato attuale.

## Comunicazione e community (capitolo nuovo)

- Annuncio nel canale sviluppatori LUKSO su Telegram — buone reazioni, zero
  iscritti diretti (pubblico builder, non tifosi)
- Gruppo Telegram italiano di fantacalcio (~7.000 membri) — primo tentativo
  causa ban (regole non rispettate), secondo tentativo con permesso richiesto
  prima
- Listato nello **UP! Store** di LUKSO — contributo diretto al progetto
  open-source di terzi (Pull Request per aggiungere il campo `description`
  mancante allo schema, approvata dal maintainer)
- Materiale grafico dedicato per community diverse (tono tecnico per il
  pubblico LUKSO, tono "gioco/premio" per i tifosi)

## Punti ancora aperti

1. **Adozione reale**: nessun utente esterno confermato ancora, troppo presto
   per giudicare — attesa dati dai canali seminati
2. **Primi risultati/claim veri**: le partite importate iniziano dal 7 agosto
   (Eredivisie) — il flusso oracolo→claim non è ancora stato osservato dal
   vivo su mainnet, solo su testnet (settimane di test lì)
3. **Wallet sponsor/oracolo**: solo pochi LYX caricati per ora, sufficienti
   per il volume attuale ma da monitorare (nessun alert automatico se
   scendono sotto soglia — solo controllo manuale via pannello admin)
4. **Bio Universal Profile ChainIntegrate**: da aggiornare per menzionare i
   prodotti consumer (MatchPredictor), oggi descrive solo il lato servizi B2B
