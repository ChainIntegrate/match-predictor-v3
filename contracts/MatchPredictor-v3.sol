// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LSP8Mintable} from "@lukso/lsp8-contracts/contracts/presets/LSP8Mintable.sol";
import {_LSP8_TOKENID_FORMAT_NUMBER} from "@lukso/lsp8-contracts/contracts/LSP8Constants.sol";
import {_LSP4_TOKEN_TYPE_NFT} from "@lukso/lsp4-contracts/contracts/LSP4Constants.sol";

/// @title MatchPredictor (v3 — email-first / sponsor relay)
/// @notice Gioco di pronostici sportivi on-chain. Accesso esclusivamente via email lato
///         prodotto: nessun utente firma mai direttamente una transazione. Un indirizzo
///         "sponsor" dedicato firma e paga il gas per conto di ogni utente registrato,
///         chiamando le funzioni *For() con l'indirizzo reale del pronosticatore/vincitore
///         passato esplicitamente come parametro.
///
/// @dev Cambiamenti rispetto alla v2:
///      - Aggiunto il ruolo "sponsor", separato da "oracle", principio di minimo privilegio:
///        oracle riporta solo risultati, sponsor paga solo pronostici/claim per conto utenti.
///      - predict()/claim() ad accesso diretto RIMOSSE: nessun utente firma mai direttamente,
///        modo univoco via relay sponsor (scelta esplicita di prodotto, non limite tecnico).
///      - Aggiunte predictFor(), predictBatchFor() (batch per UN solo predictor alla volta,
///        non mescola pronostici di utenti diversi nella stessa chiamata), claimFor().
///      - Aggiunta createMatchBatch() per creare più partite in una transazione (utile con
///        campionati nazionali aperti, dove le partite proposte da football-data.org possono
///        essere centinaia in una finestra di tempo).
///      - Mantenuti dalla v2: LSP4TokenType corretto a NFT, token story on-chain per-token.
contract MatchPredictor is LSP8Mintable {
    // --- Tipi ---

    /// @notice Esito di una partita. NONE è usato come placeholder prima della risoluzione.
    enum Result {
        NONE,
        HOME_WIN,
        DRAW,
        AWAY_WIN
    }

    struct Match {
        string teamHome;
        string teamAway;
        uint256 predictionDeadline; // timestamp dopo il quale non si può più pronosticare
        bool resolved;
        Result actualResult;
        bool exists;
    }

    // --- Storage ---

    /// @notice Indirizzo autorizzato a riportare i risultati reali (il "ponte" dal mondo esterno).
    address public oracle;

    /// @notice Indirizzo autorizzato a firmare pronostici e claim per conto degli utenti
    ///         registrati via email (paga il gas, mai possiede i fondi/identità dell'utente).
    address public sponsor;

    /// @notice matchId incrementale -> dati della partita.
    mapping(uint256 => Match) public matches;

    /// @notice matchId -> wallet -> pronostico registrato.
    mapping(uint256 => mapping(address => Result)) public predictions;

    /// @notice matchId -> wallet -> ha già rivendicato il premio.
    mapping(uint256 => mapping(address => bool)) public claimed;

    uint256 public nextMatchId;
    uint256 private nextTokenId;

    /// @notice Chiave dati custom (keccak256("MatchPredictorTokenStory")) usata per
    ///         congelare on-chain i dettagli della partita vinta da ogni singolo token,
    ///         tramite setDataForTokenId(). Formato valore: stringa UTF-8 concatenata
    ///         "matchId|teamHome|teamAway|result", dove result è 1=Home, 2=Draw, 3=Away.
    ///         Scelta deliberatamente come stringa semplice (non JSON/IPFS) per evitare
    ///         dipendenze da servizi esterni nel percorso critico del mint: il frontend
    ///         decodifica direttamente questa stringa per mostrare il "certificato" della
    ///         vittoria, senza bisogno di andare a recuperare nulla fuori dalla chain.
    bytes32 public constant TOKEN_STORY_KEY = 0xc345e2857e55742bc896212b499925391cc94c97152776066ccf64e4df74ee09;

    // --- Eventi (fondamentali per lo storico leggibile da frontend/explorer) ---

    event MatchCreated(uint256 indexed matchId, string teamHome, string teamAway, uint256 predictionDeadline);
    event PredictionMade(uint256 indexed matchId, address indexed predictor, Result predictedResult);
    event PredictionSkipped(uint256 indexed matchId, address indexed predictor, string reason);
    event ResultReported(uint256 indexed matchId, Result actualResult);
    event PrizeClaimed(uint256 indexed matchId, address indexed winner, bytes32 tokenId);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);
    event SponsorUpdated(address indexed previousSponsor, address indexed newSponsor);

    // --- Errori custom (più leggibili ed economici dei require con stringhe lunghe) ---

    error NotOracle();
    error NotSponsor();
    error MatchDoesNotExist();
    error PredictionWindowClosed();
    error MatchAlreadyResolved();
    error MatchNotResolvedYet();
    error AlreadyPredicted();
    error InvalidResult();
    error NoPredictionFound();
    error AlreadyClaimed();
    error PredictionWasIncorrect();
    error DeadlineMustBeFuture();
    error ArrayLengthMismatch();
    error EmptyBatch();

    // --- Modifiers ---

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    modifier onlySponsor() {
        if (msg.sender != sponsor) revert NotSponsor();
        _;
    }

    /// @param name_ Nome della collezione NFT (es. "MatchPredictor Winners")
    /// @param symbol_ Simbolo della collezione (es. "MPW")
    /// @param ownerUP_ Universal Profile che possiede la collezione (visibilità/branding)
    /// @param oracle_ EOA dedicata che riporterà i risultati reali
    /// @param sponsor_ EOA dedicata che firma pronostici/claim per conto degli utenti email
    constructor(
        string memory name_,
        string memory symbol_,
        address ownerUP_,
        address oracle_,
        address sponsor_
    )
        LSP8Mintable(
            name_,
            symbol_,
            ownerUP_,
            _LSP4_TOKEN_TYPE_NFT,
            _LSP8_TOKENID_FORMAT_NUMBER
        )
    {
        oracle = oracle_;
        sponsor = sponsor_;
    }

    // --- Gestione partite (solo owner: sei tu/admin a creare i match) ---

    /// @notice Crea una nuova partita su cui gli utenti potranno pronosticare.
    /// @param teamHome Nome squadra di casa.
    /// @param teamAway Nome squadra in trasferta.
    /// @param predictionDeadline Timestamp unix dopo il quale i pronostici si chiudono
    ///        (tipicamente il calcio d'inizio).
    function createMatch(
        string calldata teamHome,
        string calldata teamAway,
        uint256 predictionDeadline
    ) external onlyOwner returns (uint256 matchId) {
        if (predictionDeadline <= block.timestamp) revert DeadlineMustBeFuture();

        matchId = nextMatchId++;
        matches[matchId] = Match({
            teamHome: teamHome,
            teamAway: teamAway,
            predictionDeadline: predictionDeadline,
            resolved: false,
            actualResult: Result.NONE,
            exists: true
        });

        emit MatchCreated(matchId, teamHome, teamAway, predictionDeadline);
    }

    /// @notice Crea più partite in una sola transazione. Utile quando football-data.org
    ///         propone molte partite in una finestra di tempo (es. campionati nazionali
    ///         con più gare contemporaneamente).
    /// @param teamHomes Array nomi squadre di casa.
    /// @param teamAways Array nomi squadre in trasferta, stesso ordine di teamHomes.
    /// @param predictionDeadlines Array deadline, stesso ordine.
    function createMatchBatch(
        string[] calldata teamHomes,
        string[] calldata teamAways,
        uint256[] calldata predictionDeadlines
    ) external onlyOwner returns (uint256[] memory matchIds) {
        if (teamHomes.length != teamAways.length || teamHomes.length != predictionDeadlines.length) {
            revert ArrayLengthMismatch();
        }
        if (teamHomes.length == 0) revert EmptyBatch();

        matchIds = new uint256[](teamHomes.length);

        for (uint256 i = 0; i < teamHomes.length; i++) {
            if (predictionDeadlines[i] <= block.timestamp) revert DeadlineMustBeFuture();

            uint256 matchId = nextMatchId++;
            matches[matchId] = Match({
                teamHome: teamHomes[i],
                teamAway: teamAways[i],
                predictionDeadline: predictionDeadlines[i],
                resolved: false,
                actualResult: Result.NONE,
                exists: true
            });

            matchIds[i] = matchId;
            emit MatchCreated(matchId, teamHomes[i], teamAways[i], predictionDeadlines[i]);
        }
    }

    // --- Pronostici (solo sponsor, per conto dell'utente reale) ---

    /// @notice Registra un pronostico per conto di un utente, firmato dallo sponsor.
    /// @dev Nessun utente firma mai direttamente: l'identità del pronosticatore è passata
    ///      esplicitamente come parametro e si fida del fatto che solo lo sponsor (il
    ///      backend autorizzato) possa chiamare questa funzione correttamente.
    /// @param matchId Identificativo della partita.
    /// @param predictedResult Esito previsto (HOME_WIN / DRAW / AWAY_WIN).
    /// @param predictor Indirizzo del vero pronosticatore (EOA generata per l'utente, o la
    ///        sua Universal Profile se collegata).
    function predictFor(
        uint256 matchId,
        Result predictedResult,
        address predictor
    ) external onlySponsor {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (block.timestamp >= m.predictionDeadline) revert PredictionWindowClosed();
        if (predictedResult == Result.NONE) revert InvalidResult();
        if (predictions[matchId][predictor] != Result.NONE) revert AlreadyPredicted();

        predictions[matchId][predictor] = predictedResult;
        emit PredictionMade(matchId, predictor, predictedResult);
    }

    /// @notice Registra pronostici su più partite per conto di UN SOLO utente, in una
    ///         sola transazione. Non mescola pronostici di utenti diversi: ogni chiamata
    ///         riguarda un singolo predictor su più matchId.
    /// @dev Pattern "skip on fail": una partita non valida nel batch (deadline scaduta,
    ///      già pronosticata, risultato non valido) viene saltata con un evento dedicato,
    ///      invece di far fallire l'intera transazione.
    /// @param matchIds Array di identificativi delle partite.
    /// @param predictedResults Array di esiti previsti, stesso ordine di matchIds.
    /// @param predictor Indirizzo del vero pronosticatore per tutto il batch.
    function predictBatchFor(
        uint256[] calldata matchIds,
        Result[] calldata predictedResults,
        address predictor
    ) external onlySponsor {
        if (matchIds.length == 0) revert EmptyBatch();
        if (matchIds.length != predictedResults.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < matchIds.length; i++) {
            uint256 matchId = matchIds[i];
            Result predictedResult = predictedResults[i];
            Match storage m = matches[matchId];

            if (!m.exists) {
                emit PredictionSkipped(matchId, predictor, "MatchDoesNotExist");
                continue;
            }
            if (block.timestamp >= m.predictionDeadline) {
                emit PredictionSkipped(matchId, predictor, "PredictionWindowClosed");
                continue;
            }
            if (predictedResult == Result.NONE) {
                emit PredictionSkipped(matchId, predictor, "InvalidResult");
                continue;
            }
            if (predictions[matchId][predictor] != Result.NONE) {
                emit PredictionSkipped(matchId, predictor, "AlreadyPredicted");
                continue;
            }

            predictions[matchId][predictor] = predictedResult;
            emit PredictionMade(matchId, predictor, predictedResult);
        }
    }

    // --- Oracolo (solo backend autorizzato, solo dopo la deadline) ---

    /// @notice Riporta il risultato reale della partita. Chiamabile solo dall'oracolo.
    /// @dev Questo è il "ponte" tra il mondo esterno (API risultati calcio) e la blockchain.
    /// @param matchId Identificativo della partita.
    /// @param actualResult Esito reale verificato dall'oracolo.
    function reportResult(uint256 matchId, Result actualResult) external onlyOracle {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (m.resolved) revert MatchAlreadyResolved();
        if (actualResult == Result.NONE) revert InvalidResult();

        m.resolved = true;
        m.actualResult = actualResult;

        emit ResultReported(matchId, actualResult);
    }

    // --- Claim del premio (solo sponsor, per conto del vincitore) ---

    /// @notice Rivendica l'NFT premio per conto di un utente, se il suo pronostico era
    ///         corretto. Firmato dallo sponsor, mai dall'utente direttamente.
    /// @param matchId Identificativo della partita.
    /// @param winner Indirizzo del vincitore (EOA generata o UP collegata).
    function claimFor(uint256 matchId, address winner) external onlySponsor {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (!m.resolved) revert MatchNotResolvedYet();

        Result winnerPrediction = predictions[matchId][winner];
        if (winnerPrediction == Result.NONE) revert NoPredictionFound();
        if (claimed[matchId][winner]) revert AlreadyClaimed();
        if (winnerPrediction != m.actualResult) revert PredictionWasIncorrect();

        claimed[matchId][winner] = true;

        bytes32 tokenId = bytes32(nextTokenId++);
        _mint(winner, tokenId, true, "");

        // Congela on-chain i dettagli della vittoria, per-token, leggibili
        // indipendentemente da qualsiasi servizio esterno o stato futuro del contratto.
        string memory story = string.concat(
            _toString(matchId),
            "|",
            m.teamHome,
            "|",
            m.teamAway,
            "|",
            _toString(uint256(m.actualResult))
        );
        _setDataForTokenId(tokenId, TOKEN_STORY_KEY, bytes(story));

        emit PrizeClaimed(matchId, winner, tokenId);
    }

    /// @dev Conversione minimale uint256 -> string decimale, senza dipendenze esterne
    ///      (evita di importare l'intera libreria OpenZeppelin Strings solo per questo).
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    // --- Amministrazione oracolo ---

    /// @notice Aggiorna l'indirizzo dell'oracolo autorizzato (es. in caso di rotazione chiavi).
    function setOracle(address newOracle) external onlyOwner {
        address previous = oracle;
        oracle = newOracle;
        emit OracleUpdated(previous, newOracle);
    }

    /// @notice Aggiorna l'indirizzo sponsor autorizzato (es. in caso di rotazione chiavi).
    function setSponsor(address newSponsor) external onlyOwner {
        address previous = sponsor;
        sponsor = newSponsor;
        emit SponsorUpdated(previous, newSponsor);
    }

    // --- View helper per il frontend ---

    /// @notice Ritorna i dati completi di una partita in un'unica chiamata.
    function getMatch(uint256 matchId) external view returns (Match memory) {
        if (!matches[matchId].exists) revert MatchDoesNotExist();
        return matches[matchId];
    }

    /// @notice Verifica se un wallet ha vinto (pronostico corretto) per una partita risolta.
    function hasWon(uint256 matchId, address wallet) external view returns (bool) {
        Match storage m = matches[matchId];
        if (!m.exists || !m.resolved) return false;
        Result p = predictions[matchId][wallet];
        return p != Result.NONE && p == m.actualResult;
    }
}
