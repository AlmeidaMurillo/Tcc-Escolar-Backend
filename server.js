require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const brevo = require("@getbrevo/brevo");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

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

function autenticar(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Token não fornecido" });
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET_USER || "segredoUsuario", (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido ou expirado" });
    req.user = user;
    next();
  });
}

function autenticarAdmin(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Token não fornecido" });
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET_ADMIN || "segredoAdmin", (err, admin) => {
    if (err) return res.status(403).json({ error: "Token inválido ou expirado" });
    req.admin = admin;
    next();
  });
}

// logs

async function Logs(id_usuario, tipo, detalhes, req, identificador = null) {
  try {
    let usuarioId = id_usuario;

    if (identificador) {
      const [rows] = await pool.query(
        "SELECT id FROM usuarios WHERE email = ? OR cpf = ?",
        [identificador, identificador]
      );
      if (rows.length > 0) {
        usuarioId = rows[0].id;
      }
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Desconhecido';

    const now = new Date();
    now.setHours(now.getHours() - 3);
    const dataCriacao = now.toISOString().slice(0, 19).replace("T", " ");

    await pool.query(
      `INSERT INTO logs (id_usuario, tipo, detalhes, ip_origem, user_agent, data_criacao) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [usuarioId, tipo, detalhes, ip, userAgent, dataCriacao]
    );
  } catch (err) {
    console.error("Erro ao registrar log:", err);
  }
}


const brevoClient = new brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

app.get("/logs", autenticarAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        l.id_log AS id,
        l.id_usuario, 
        u.nome AS usuario, 
        l.tipo, 
        l.detalhes, 
        l.ip_origem, 
        l.user_agent, 
        l.data_criacao
      FROM logs l
      LEFT JOIN usuarios u ON u.id = l.id_usuario
      ORDER BY l.data_criacao DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar logs:", err);
    res.status(500).json({ error: "Erro ao buscar logs" });
  }
});


app.get("/logs/recentes", autenticarAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                l.id_log AS id,
                l.id_usuario,
                u.nome AS usuario,
                l.tipo,
                l.detalhes,
                l.data_criacao
            FROM logs l
            LEFT JOIN usuarios u ON u.id = l.id_usuario
            ORDER BY l.data_criacao DESC
            LIMIT 3
        `);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar logs recentes:", err);
        res.status(500).json({ error: "Erro ao buscar logs recentes" });
    }
});



app.post("/recuperar-senha/enviar-codigo", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    await Logs(null, "recuperar_senha_erro", "Email não informado", req);
    return res.status(400).json({ error: "Informe o email" });
  }

  try {
    const [rows] = await pool.query("SELECT * FROM usuarios WHERE email = ?", [email]);
    if (rows.length === 0) {
      await Logs(null, "recuperar_senha_erro", `Email não encontrado: ${email}`, req);
      return res.status(404).json({ error: "Email não encontrado" });
    }

    const usuario = rows[0];
    if (usuario.situacao !== "aprovado") {
      await Logs(usuario.id, "recuperar_senha_erro", `Usuário não aprovado: ${email}`, req);
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

    await Logs(usuario.id, "recuperar_senha_enviar", `Código enviado para o email: ${email}`, req);
    res.json({ message: "Código enviado para o email", situacao: usuario.situacao });
  } catch (err) {
    console.error(err);
    await Logs(null, "recuperar_senha_erro", `Erro ao enviar código para ${email}: ${err.message}`, req, email);
    res.status(500).json({ error: "Erro ao enviar código" });
  }
});

app.post("/recuperar-senha/validar-codigo", async (req, res) => {
  const { email, codigo } = req.body;
  if (!email || !codigo) {
    await Logs(null, "recuperar_senha_erro", "Dados inválidos ao validar código", req);
    return res.status(400).json({ error: "Dados inválidos" });
  }

  const dados = global.codigosRecuperacao?.[email];
  if (!dados) {
    await Logs(null, "recuperar_senha_erro", `Código não solicitado para: ${email}`, req, email);
    return res.status(400).json({ error: "Código não solicitado" });
  }
  if (Date.now() > dados.expira) {
    await Logs(null, "recuperar_senha_erro", `Código expirado para: ${email}`, req, email);
    return res.status(400).json({ error: "Código expirado" });
  }
  if (dados.codigo != codigo) {
    await Logs(null, "recuperar_senha_erro", `Código inválido para: ${email}`, req, email);
    return res.status(400).json({ error: "Código inválido" });
  }

  const [usuarioRows] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
  const usuarioId = usuarioRows.length > 0 ? usuarioRows[0].id : null;

  await Logs(usuarioId, "recuperar_senha_validar", `Código válido para: ${email}`, req);
  res.json({ message: "Código válido" });
});

app.post("/recuperar-senha/redefinir", async (req, res) => {
  const { email, novaSenha } = req.body;
  if (!email || !novaSenha) {
    await Logs(null, "recuperar_senha_erro", "Dados inválidos ao redefinir senha", req);
    return res.status(400).json({ error: "Dados inválidos" });
  }

  try {
    const [rows] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
    if (rows.length === 0) {
      await Logs(null, "recuperar_senha_erro", `Usuário não encontrado ao redefinir senha: ${email}`, req, email);
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    const usuarioId = rows[0].id;
    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query("UPDATE usuarios SET senha = ? WHERE email = ?", [hash, email]);

    await Logs(usuarioId, "recuperar_senha_redefinir", `Senha redefinida com sucesso para: ${email}`, req);
    res.json({ message: "Senha atualizada com sucesso" });
  } catch (err) {
    console.error(err);
    await Logs(null, "recuperar_senha_erro", `Erro ao redefinir senha para ${email}: ${err.message}`, req, email);
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

app.get("/usuarios", autenticarAdmin, async (req, res) => {
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

app.get("/usuarios/meus-dados", autenticar, async (req, res) => {
  const userId = req.user.id;

  try {
    const [rows] = await pool.query(
      `SELECT id, nome, email, cpf, telefone, saldo
       FROM usuarios
       WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Usuário não encontrado" });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar dados do usuário" });
  }
});


app.post("/usuarios", async (req, res) => {
  const { cpf, nome, senha, email, telefone, data_nascimento } = req.body;

  if (!cpf || !nome || !senha || !email) {
    await Logs(null, "cadastro_erro", "CPF, nome, senha ou email não informados", req);
    return res
      .status(400)
      .json({ error: "CPF, nome, senha e e-mail são obrigatórios" });
  }

  try {
    const [existing] = await pool.query("SELECT id FROM usuarios WHERE cpf = ?", [cpf]);
    if (existing.length > 0) {
      await Logs(null, "cadastro_erro", `Tentativa de cadastro com CPF já existente: ${cpf}`, req);
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

    await Logs(usuario[0].id, "cadastro_sucesso", `Usuário ${nome} cadastrado com sucesso`, req);

    res.status(201).json(usuario[0]);
  } catch (err) {
    console.error("Erro ao criar usuário:", err);
    await Logs(null, "cadastro_erro", `Erro ao criar usuário ${nome} - ${err.message}`, req);
    res.status(500).json({ error: "Erro ao criar usuário", details: err.message });
  }
});

app.post("/login", async (req, res) => {
  const { cpf, senha } = req.body;
  if (!cpf || !senha) return res.status(400).json({ error: "CPF e senha são obrigatórios" });
  try {
    const [rows] = await pool.query("SELECT id, cpf, senha, situacao FROM usuarios WHERE cpf = ?", [cpf]);
    if (rows.length === 0) {
      await Logs(null, "login_erro", `CPF não encontrado: ${cpf}`, req);
      return res.status(404).json({ error: "CPF não encontrado" });
    }
    const usuario = rows[0];
    const senhaValida = await bcrypt.compare(senha, usuario.senha);
    if (!senhaValida) {
      await Logs(usuario.id, "login_erro", "Senha incorreta", req);
      return res.status(401).json({ error: "Senha incorreta" });
    }
    switch (usuario.situacao) {
      case "aprovado":
        await Logs(usuario.id, "login_sucesso", "Usuário logou com sucesso", req);
        const token = jwt.sign(
          { id: usuario.id, cpf: usuario.cpf, role: "user" },
          process.env.JWT_SECRET_USER || "segredoUsuario",
          { expiresIn: "1h" }
        );
        return res.json({ message: "Login realizado com sucesso", situacao: usuario.situacao, token });
      case "rejeitado":
        await Logs(usuario.id, "login_erro", "Usuário rejeitado tentou login", req);
        return res.status(403).json({ error: "Usuário rejeitado" });
      case "analise":
        await Logs(usuario.id, "login_erro", "Usuário em análise tentou login", req);
        return res.status(403).json({ error: "Usuário em análise" });
      case "bloqueado":
        await Logs(usuario.id, "login_erro", "Usuário bloqueado tentou login", req);
        return res.status(403).json({ error: "Usuário bloqueado" });
      default:
        await Logs(usuario.id, "login_erro", `Situação desconhecida: ${usuario.situacao}`, req);
        return res.status(400).json({ error: "Situação inválida" });
    }
  } catch (err) {
    console.error(err);
    await Logs(null, "login_erro", `Erro ao processar login: ${err.message}`, req);
    res.status(500).json({ error: "Erro ao processar login" });
  }
});

app.post("/loginadmin", async (req, res) => {
  const { usuario, senha } = req.body;

  if (!usuario || !senha) {
    return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
  }

  try {
    const [rows] = await pool.query(
      "SELECT usuario, senha FROM admins WHERE usuario = ?",
      [usuario]
    );

    if (rows.length === 0 || senha !== rows[0].senha) {
      return res.status(401).json({ error: "Usuário ou senha incorretos" });
    }

    const token = jwt.sign(
      { usuario: rows[0].usuario, role: "admin" },
      process.env.JWT_SECRET_ADMIN || "segredoAdmin",
      { expiresIn: "8h" }
    );

    await Logs(null, "login_sucesso", `Admin ${usuario} logou com sucesso`, req);

    res.json({
      message: "Login admin realizado com sucesso",
      usuario: rows[0].usuario,
      token
    });
  } catch (err) {
    console.error("Erro ao processar login admin:", err);
    res.status(500).json({ error: "Erro ao processar login" });
  }
});


app.get("/usuarios/pendentes", autenticarAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, email, cpf, telefone, data_nascimento, datasolicitacao, situacao FROM usuarios WHERE situacao = 'analise' OR situacao = 'rejeitado'"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar usuários pendentes" });
  }
});

app.patch("/usuarios/:id/aprovar", autenticarAdmin, async (req, res) => {
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


app.patch("/usuarios/:id/rejeitar", autenticarAdmin, async (req, res) => {
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


app.get("/usuarios/pendentes/count", autenticarAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'analise'");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários pendentes" });
  }
});

app.get("/usuarios/aprovados/count", autenticarAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'aprovado'");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários aprovados" });
  }
});

app.get("/usuarios/bloqueados/count", autenticarAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'bloqueado'");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários bloqueados" });
  }
});

app.get("/usuarios/rejeitados/count", autenticarAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios WHERE situacao = 'rejeitado'");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários aprovados" });
  }
});

app.get("/usuarios/count", autenticarAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM usuarios");
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar usuários" });
  }
});

app.get("/usuarios/buscar", autenticar, async (req, res) => {
  const { tipo, valor } = req.query;

  if (!tipo || !valor) return res.status(400).json({ error: "Tipo e valor são obrigatórios" });

  try {
    let query = "";
    let params = [];

    switch(tipo.toLowerCase()) {
      case "email":
        query = "SELECT id, nome, email, telefone, cpf, saldo FROM usuarios WHERE email = ?";
        params = [valor];
        break;
      case "telefone":
        query = "SELECT id, nome, email, telefone, cpf, saldo FROM usuarios WHERE telefone = ?";
        params = [valor];
        break;
      case "cpf":
        query = "SELECT id, nome, email, telefone, cpf, saldo FROM usuarios WHERE cpf = ?";
        params = [valor];
        break;
      default:
        return res.status(400).json({ error: "Tipo inválido. Use Email, Telefone ou CPF" });
    }

    const [rows] = await pool.query(query, params);

    if (rows.length === 0) return res.status(404).json({ error: "Usuário não encontrado" });

    res.json(rows[0]);

  } catch (err) {
    console.error("Erro ao buscar usuário:", err);
    res.status(500).json({ error: "Erro ao buscar usuário" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
