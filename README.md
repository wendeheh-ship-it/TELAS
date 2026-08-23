# TELAS 🖥️

App de compartilhamento de tela em tempo real estilo Discord.

## Como rodar

```bash
# Instalar dependências (só na primeira vez)
npm install

# Iniciar o servidor
npm start
```

Acesse: **http://localhost:3000**

## Como compartilhar com amigos na mesma rede

1. Rode `npm start`
2. Descubra seu IP local: `ipconfig` (Windows)
3. Passe o endereço `http://SEU_IP:3000` para seus amigos

## Para acesso pela internet (fora da rede local)

Use o [ngrok](https://ngrok.com/) para expor o servidor:

```bash
npx ngrok http 3000
```

O ngrok vai gerar um link público (ex: `https://xxxx.ngrok.io`) que qualquer pessoa pode acessar.

## Funcionalidades

- Compartilhamento de tela com áudio do sistema
- Câmera e microfone
- Chat em tempo real
- Salas com link compartilhável
- Múltiplos participantes simultâneos
- Tema escuro estilo Discord

## Estrutura

```
TELAS/
├── server.js          ← Servidor Node.js + Socket.IO
├── package.json
└── public/
    ├── index.html     ← Lobby (criar/entrar em sala)
    ├── room.html      ← Página da sala
    ├── css/style.css  ← Tema escuro
    └── js/room.js     ← Lógica WebRTC
```
