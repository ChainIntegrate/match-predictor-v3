// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LSP8Mintable} from "@lukso/lsp8-contracts/contracts/presets/LSP8Mintable.sol";
import {_LSP8_TOKENID_FORMAT_NUMBER} from "@lukso/lsp8-contracts/contracts/LSP8Constants.sol";
import {_LSP4_TOKEN_TYPE_NFT} from "@lukso/lsp4-contracts/contracts/LSP4Constants.sol";

/// @title MatchPredictor (v2)
/// @notice Gioco di pronostici sportivi on-chain. Un oracolo centralizzato (backend off-chain)
///         riporta il risultato reale di una partita dopo che si è conclusa; chi ha pronosticato
///         correttamente può rivendicare un NFT premio (LSP8).
///
/// @dev Modifiche rispetto alla v1, pronte per il prossimo deploy (nuova competizione):
///      1. LSP4TokenType corretto a NFT (1) invece di Token generico (0) — la v1 aveva questo
///         valore sbagliato, causando la mancata visualizzazione degli NFT vinti nella sezione
///         Collectibles dell'app/estensione Universal Profile (la proprietà on-chain restava
///         comunque corretta e verificabile, solo l'interfaccia UPC non la mostrava).
///      2. Aggiunta predictBatch(): permette di pronosticare più partite in una sola transazione,
///         con logica "skip on fail" — se una partita nel batch non è valida (deadline scaduta,
///         già pronosticata, risultato non valido), viene saltata silenziosamente e si procede
///         con le altre, invece di fare revert sull'intera transazione.
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

    // --- Errori custom (più leggibili ed economici dei require con stringhe lunghe) ---

    error NotOracle();
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

    /// @param name_ Nome della collezione NFT (es. "MatchPredictor Winners")
    /// @param symbol_ Simbolo della collezione (es. "MPW")
    /// @param ownerUP_ Universal Profile che possiede la collezione (visibilità/branding)
    /// @param oracle_ EOA dedicata che riporterà i risultati reali
    constructor(
        string memory name_,
        string memory symbol_,
        address ownerUP_,
        address oracle_
    )
        LSP8Mintable(
            name_,
            symbol_,
            ownerUP_,
            _LSP4_TOKEN_TYPE_NFT, // corretto: NFT (era 0/Token nella v1, bug fix)
            _LSP8_TOKENID_FORMAT_NUMBER
        )
    {
        oracle = oracle_;
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

    // --- Pronostici (chiunque, prima della deadline) ---

    /// @notice Registra il proprio pronostico per una partita. Un solo pronostico per wallet.
    /// @param matchId Identificativo della partita.
    /// @param predictedResult Esito previsto (HOME_WIN / DRAW / AWAY_WIN).
    function predict(uint256 matchId, Result predictedResult) external {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (block.timestamp >= m.predictionDeadline) revert PredictionWindowClosed();
        if (predictedResult == Result.NONE) revert InvalidResult();
        if (predictions[matchId][msg.sender] != Result.NONE) revert AlreadyPredicted();

        predictions[matchId][msg.sender] = predictedResult;
        emit PredictionMade(matchId, msg.sender, predictedResult);
    }

    /// @notice Registra pronostici per più partite in una sola transazione.
    /// @dev Pattern "skip on fail": se una partita nel batch non è valida per qualsiasi motivo
    ///      (non esiste, deadline scaduta, risultato non valido, già pronosticata), viene
    ///      saltata silenziosamente (con evento PredictionSkipped) e si continua con le altre,
    ///      invece di fare revert sull'intera transazione. Questo evita che un singolo elemento
    ///      problematico (es. per timing) faccia perdere gas e validità a un intero batch di
    ///      pronostici altrimenti validi.
    /// @param matchIds Array di identificativi delle partite.
    /// @param predictedResults Array di esiti previsti, stesso ordine di matchIds.
    function predictBatch(
        uint256[] calldata matchIds,
        Result[] calldata predictedResults
    ) external {
        if (matchIds.length == 0) revert EmptyBatch();
        if (matchIds.length != predictedResults.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < matchIds.length; i++) {
            uint256 matchId = matchIds[i];
            Result predictedResult = predictedResults[i];
            Match storage m = matches[matchId];

            if (!m.exists) {
                emit PredictionSkipped(matchId, msg.sender, "MatchDoesNotExist");
                continue;
            }
            if (block.timestamp >= m.predictionDeadline) {
                emit PredictionSkipped(matchId, msg.sender, "PredictionWindowClosed");
                continue;
            }
            if (predictedResult == Result.NONE) {
                emit PredictionSkipped(matchId, msg.sender, "InvalidResult");
                continue;
            }
            if (predictions[matchId][msg.sender] != Result.NONE) {
                emit PredictionSkipped(matchId, msg.sender, "AlreadyPredicted");
                continue;
            }

            predictions[matchId][msg.sender] = predictedResult;
            emit PredictionMade(matchId, msg.sender, predictedResult);
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

    // --- Claim del premio (chi ha indovinato) ---

    /// @notice Rivendica l'NFT premio se il proprio pronostico era corretto.
    /// @param matchId Identificativo della partita.
    function claim(uint256 matchId) external {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (!m.resolved) revert MatchNotResolvedYet();

        Result myPrediction = predictions[matchId][msg.sender];
        if (myPrediction == Result.NONE) revert NoPredictionFound();
        if (claimed[matchId][msg.sender]) revert AlreadyClaimed();
        if (myPrediction != m.actualResult) revert PredictionWasIncorrect();

        claimed[matchId][msg.sender] = true;

        bytes32 tokenId = bytes32(nextTokenId++);
        _mint(msg.sender, tokenId, true, "");

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

        emit PrizeClaimed(matchId, msg.sender, tokenId);
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
