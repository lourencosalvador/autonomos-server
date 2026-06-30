import dotenv from 'dotenv';

// Repo standalone: carrega o .env da raiz do projeto (cwd).
// No Railway/produção as variáveis são injetadas no ambiente, e o dotenv apenas
// não encontra ficheiro (no-op) — sem problema.
dotenv.config();
