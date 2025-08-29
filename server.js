require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const brevo = require("@getbrevo/brevo");
const bcrypt = require("bcrypt");

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
  timezone: "-03:00",
});

const brevoClient = new brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);



app.post("/recuperar-senha/enviar-codigo", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Informe o email" });

  try {
    const [rows] = await pool.query("SELECT * FROM usuarios WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Email não encontrado" });
    }

    const usuario = rows[0];

    if (usuario.situacao !== "aprovado") {
      return res.json({ situacao: usuario.situacao });
    }

    const codigo = Math.floor(100000 + Math.random() * 900000);
    global.codigosRecuperacao = global.codigosRecuperacao || {};
    global.codigosRecuperacao[email] = { codigo, expira: Date.now() + 5 * 60 * 1000 };

    await brevoClient.sendTransacEmail({
      sender: { email: "almeidamurillo196@gmail.com", name: "Sistema TCC" },
      to: [{ email }],
      subject: "Recuperação de senha",
      htmlContent: `<p>Seu código de recuperação é: <b>${codigo}</b></p>`,
    });

    res.json({ message: "Código enviado para o email", situacao: usuario.situacao });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar código" });
  }
});

app.post("/recuperar-senha/validar-codigo", (req, res) => {
  const { email, codigo } = req.body;
  if (!email || !codigo) return res.status(400).json({ error: "Dados inválidos" });

  const dados = global.codigosRecuperacao?.[email];
  if (!dados) return res.status(400).json({ error: "Código não solicitado" });
  if (Date.now() > dados.expira) return res.status(400).json({ error: "Código expirado" });
  if (dados.codigo != codigo) return res.status(400).json({ error: "Código inválido" });

  res.json({ message: "Código válido" });
});

app.post("/recuperar-senha/redefinir", async (req, res) => {
  const { email, novaSenha } = req.body;
  if (!email || !novaSenha) return res.status(400).json({ error: "Dados inválidos" });

  try {
    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query("UPDATE usuarios SET senha = ? WHERE email = ?", [hash, email]);
    res.json({ message: "Senha atualizada com sucesso" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao atualizar senha" });
  }
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
  let { search = "", status = "todos" } = req.query;

  status = status.toLowerCase();

  try {
    let query = "SELECT * FROM usuarios WHERE situacao IN ('aprovado','bloqueado')";
    const values = [];

    if (status !== "todos") {
      query += " AND situacao = ?";
      values.push(status);
    }

    if (search) {
      query += " AND (nome LIKE ? OR cpf LIKE ?)";
      values.push(`%${search}%`, `%${search}%`);
    }

    const [rows] = await pool.query(query, values);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar usuários:", err);
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
  try {
    const [rows] = await pool.query("SELECT id FROM usuarios WHERE nome = ?", [nome]);
    res.json({ exists: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: "Erro ao verificar nome" });
  }
});

app.get("/usuarios/check-email/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const [rows] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
    res.json({ exists: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: "Erro ao verificar email" });
  }
});

app.get("/usuarios/check-telefone/:telefone", async (req, res) => {
  const { telefone } = req.params;
  try {
    const [rows] = await pool.query("SELECT id FROM usuarios WHERE telefone = ?", [telefone]);
    res.json({ exists: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: "Erro ao verificar telefone" });
  }
});

app.post("/usuarios", async (req, res) => {
  const { cpf, nome, senha, email, telefone, data_nascimento } = req.body;

  if (!cpf || !nome || !senha || !email) {
    return res
      .status(400)
      .json({ error: "CPF, nome, senha e e-mail são obrigatórios" });
  }

  try {
    const [existing] = await pool.query("SELECT id FROM usuarios WHERE cpf = ?", [cpf]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "CPF já cadastrado" });
    }

    const hashSenha = await bcrypt.hash(senha, 10);

    let formattedBirthDate = null;
    if (data_nascimento) {
      const date = new Date(data_nascimento);
      if (!isNaN(date)) {
        formattedBirthDate = date.toISOString().split("T")[0];
      }
    }

    const now = new Date();
    now.setHours(now.getHours() - 3);
    const datasolicitacao = now.toISOString().slice(0, 19).replace("T", " ");

    const [result] = await pool.query(
      `INSERT INTO usuarios 
        (cpf, nome, senha, email, telefone, data_nascimento, situacao, datacriacao, datasolicitacao) 
       VALUES (?, ?, ?, ?, ?, ?, 'analise', NULL, ?)`,
      [cpf, nome, hashSenha, email, telefone || null, formattedBirthDate, datasolicitacao]
    );

    const [usuario] = await pool.query(
      `SELECT id, cpf, nome, email, telefone, 
              DATE_FORMAT(data_nascimento, '%Y-%m-%d') AS data_nascimento, 
              situacao, datasolicitacao 
         FROM usuarios 
        WHERE id = ?`,
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
    if (rows.length === 0) return res.status(404).json({ error: "CPF não encontrado" });

    const usuario = rows[0];
    const senhaValida = await bcrypt.compare(senha, usuario.senha);
    if (!senhaValida) return res.status(401).json({ error: "Senha incorreta" });

    res.json({ message: "Login realizado com sucesso", situacao: usuario.situacao });
  } catch (err) {
    res.status(500).json({ error: "Erro ao processar login" });
  }
});

app.post("/loginadmin", async (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) return res.status(400).json({ error: "Usuário e senha são obrigatórios" });

  try {
    const [rows] = await pool.query("SELECT usuario, senha FROM admins WHERE usuario = ?", [usuario]);
    if (rows.length === 0 || senha !== rows[0].senha)
      return res.status(401).json({ error: "Usuário ou senha incorretos" });

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
    const now = new Date();
    now.setHours(now.getHours() - 3);
    const datacriacao = now.toISOString().slice(0, 19).replace("T", " ");

    await pool.query(
      "UPDATE usuarios SET situacao = 'aprovado', datacriacao = ? WHERE id = ?",
      [datacriacao, id]
    );

    const [rows] = await pool.query("SELECT nome, email FROM usuarios WHERE id = ?", [id]);
    if (rows.length > 0) {
      const usuario = rows[0];

      await brevoClient.sendTransacEmail({
        sender: { email: "almeidamurillo196@gmail.com", name: "Sistema TCC" },
        to: [{ email: usuario.email }],
        subject: "✅ Cadastro Aprovado",
        htmlContent: `
          <p>Olá <b>${usuario.nome}</b>,</p>
          <p>Seus dados foram <span style="color:green"><b>aprovados</b></span> com sucesso!</p>
          <p>Agora você já pode acessar o sistema normalmente clicando no link abaixo:</p>
          <p>
            <a href="https://mercadopago-psi.vercel.app/login" 
               style="display:inline-block;padding:10px 20px;background:#28a745;color:#fff;
                      text-decoration:none;border-radius:5px;font-weight:bold;">
              👉 Acessar Sistema
            </a>
          </p>
        `,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao aprovar usuário:", err);
    res.status(500).json({ error: "Erro ao aprovar usuário" });
  }
});


app.patch("/usuarios/:id/rejeitar", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE usuarios SET situacao = 'rejeitado' WHERE id = ?", [id]);

    const [rows] = await pool.query("SELECT nome, email FROM usuarios WHERE id = ?", [id]);
    if (rows.length > 0) {
      const usuario = rows[0];

      await brevoClient.sendTransacEmail({
        sender: { email: "almeidamurillo196@gmail.com", name: "Sistema TCC" },
        to: [{ email: usuario.email }],
        subject: "❌ Cadastro Reprovado",
        htmlContent: `<p>Olá <b>${usuario.nome}</b>,</p>
                      <p>Infelizmente seus dados foram <span style="color:red"><b>reprovados</b></span>.</p>
                      <p>Entre em contato com o suporte caso queira mais informações.</p>`,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao rejeitar usuário:", err);
    res.status(500).json({ error: "Erro ao rejeitar usuário" });
  }
});


app.get("/usuarios/pendentes/count", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'analise'");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários pendentes" });
  }
});

app.get("/usuarios/aprovados/count", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'aprovado'");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários aprovados" });
  }
});

app.get("/usuarios/count", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
