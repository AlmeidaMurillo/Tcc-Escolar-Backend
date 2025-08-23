require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

app.get("/", (req, res) => {
  res.send("✅ Backend + MySQL rodando!");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "API está rodando 🚀" });
});

app.get("/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT NOW() AS now");
    res.json({ db_time: rows[0].now });
  } catch (err) {
    res.status(500).json({ error: "Erro ao conectar no banco" });
  }
});

app.get("/usuarios", async (req, res) => {
  try {
    const [results] = await pool.query("SELECT * FROM usuarios");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

app.get("/usuarios/check-cpf/:cpf", async (req, res) => {
  const { cpf } = req.params;
  try {
    const [rows] = await pool.query("SELECT id FROM usuarios WHERE cpf = ?", [cpf]);
    res.json({ exists: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: "Erro ao verificar CPF" });
  }
});

app.get("/usuarios/check-nome/:nome", async (req, res) => {
  const { nome } = req.params;
  const [rows] = await pool.query("SELECT id FROM usuarios WHERE nome = ?", [nome]);
  res.json({ exists: rows.length > 0 });
});

app.get("/usuarios/check-email/:email", async (req, res) => {
  const { email } = req.params;
  const [rows] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
  res.json({ exists: rows.length > 0 });
});

app.get("/usuarios/check-telefone/:telefone", async (req, res) => {
  const { telefone } = req.params;
  const [rows] = await pool.query("SELECT id FROM usuarios WHERE telefone = ?", [telefone]);
  res.json({ exists: rows.length > 0 });
});


app.post("/usuarios", async (req, res) => {
  const { cpf, nome, senha, email, telefone, data_nascimento } = req.body;
  if (!cpf || !nome || !senha || !email) return res.status(400).json({ error: "CPF, nome, senha e e-mail são obrigatórios" });

  try {
    const [existing] = await pool.query("SELECT id FROM usuarios WHERE cpf = ?", [cpf]);
    if (existing.length > 0) return res.status(409).json({ error: "CPF já cadastrado" });

    let formattedBirthDate = null;
    if (data_nascimento) {
      const date = new Date(data_nascimento);
      if (!isNaN(date)) {
        date.setDate(date.getDate() + 1);
        formattedBirthDate = date.toISOString().split("T")[0];
      }
    }

    const [result] = await pool.query(
      "INSERT INTO usuarios (cpf, nome, senha, email, telefone, data_nascimento, situacao, datacriacao) VALUES (?, ?, ?, ?, ?, ?, 'analise', NULL)",
      [cpf, nome, senha, email, telefone || null, formattedBirthDate]
    );
    const [usuario] = await pool.query(
      "SELECT id, cpf, nome, senha, email, telefone, DATE_FORMAT(data_nascimento, '%Y-%m-%d') AS data_nascimento, situacao FROM usuarios WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json(usuario[0]);
  } catch (err) {
    console.error("Erro ao criar usuário:", err);
    res.status(500).json({ error: "Erro ao criar usuário", details: err.message });
  }
});


app.post("/login", async (req, res) => {
  const { cpf, senha } = req.body;
  if (!cpf || !senha) return res.status(400).json({ error: "CPF e senha são obrigatórios" });

  try {
    const [rows] = await pool.query("SELECT id, cpf, senha, situacao FROM usuarios WHERE cpf = ?", [cpf]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "CPF não encontrado" });
    }

    const usuario = rows[0];

    if (senha !== usuario.senha) {
      return res.status(401).json({ error: "Senha incorreta" });
    }

    res.json({
      message: "Login realizado com sucesso",
      situacao: usuario.situacao
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao processar login" });
  }
});


// ROTAS ADMIN ABAIXO


app.post("/loginadmin", async (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
  try {
    const [rows] = await pool.query("SELECT usuario, senha FROM admins WHERE usuario = ?", [usuario]);
    if (rows.length === 0 || senha !== rows[0].senha) {
      return res.status(401).json({ error: "Usuário ou senha incorretos" });
    }
    res.json({ message: "Login realizado com sucesso", usuario: rows[0].usuario });
  } catch (err) {
    res.status(500).json({ error: "Erro ao processar login" });
  }
});

app.get("/usuarios/pendentes", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, email, cpf, telefone, data_nascimento, datasolicitacao, situacao FROM usuarios WHERE situacao = 'analise' OR situacao = 'rejeitado'"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar usuários pendentes" });
  }
});

app.patch("/usuarios/:id/aprovar", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      "UPDATE usuarios SET situacao = 'aprovado', datacriacao = NOW() WHERE id = ?",
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao aprovar usuário" });
  }
});

app.patch("/usuarios/:id/rejeitar", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE usuarios SET situacao = 'rejeitado' WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao rejeitar usuário" });
  }
});

app.get("/usuarios/pendentes/count", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'analise'"
    );
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários pendentes" });
  }
});

app.get("/usuarios/aprovados/count", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'aprovado'"
    );
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários aprovados" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
