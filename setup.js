require("dotenv").config();
const mysql = require("mysql2/promise");

async function setupDatabase() {
  let connection;

  try {
    connection = await mysql.createConnection({
      host: process.env.MYSQLHOST,
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
    });

    console.log("Conectado ao banco de dados.");

    const createUsuarios = `
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT NOT NULL AUTO_INCREMENT,
        cpf VARCHAR(20) NOT NULL,
        nome VARCHAR(100) NOT NULL,
        senha VARCHAR(255) NOT NULL,
        email VARCHAR(100) NOT NULL,
        telefone VARCHAR(20) DEFAULT NULL,
        data_nascimento DATE DEFAULT NULL,
        datacriacao DATETIME DEFAULT NULL,
        datasolicitacao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        situacao VARCHAR(20) NOT NULL,
        saldo DECIMAL(20, 2) DEFAULT 0.00,
        PRIMARY KEY (id),
        UNIQUE KEY cpf (cpf)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    const createLogs = `
      CREATE TABLE IF NOT EXISTS logs (
        id_log INT NOT NULL AUTO_INCREMENT,
        id_usuario INT DEFAULT NULL,
        tipo VARCHAR(100) NOT NULL,
        detalhes TEXT,
        data_criacao TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        ip_origem VARCHAR(45) DEFAULT NULL,
        user_agent VARCHAR(255) DEFAULT NULL,
        PRIMARY KEY (id_log)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    const createAdmins = `
      CREATE TABLE IF NOT EXISTS admins (
        usuario VARCHAR(100) DEFAULT NULL,
        senha VARCHAR(255) DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    const createTransferencias = `
      CREATE TABLE IF NOT EXISTS transferencias (
        id INT NOT NULL AUTO_INCREMENT,
        id_usuario_origem INT NOT NULL,
        cpf_destino VARCHAR(20) NOT NULL,
        nome_destino VARCHAR(100) NOT NULL,
        valor DECIMAL(20, 2) NOT NULL,
        data DATETIME NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    await connection.execute(createUsuarios);
    await connection.execute(createLogs);
    await connection.execute(createAdmins);
    await connection.execute(createTransferencias);

    console.log("Tabelas criadas/validadas com sucesso!");
  } catch (error) {
    console.error("Erro durante o setup:", error);
  } finally {
    if (connection) {
      await connection.end();
      console.log("Conexão fechada.");
    }
  }
}

setupDatabase();
