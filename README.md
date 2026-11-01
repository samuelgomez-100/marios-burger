# Mario's Burger & Lomitos · Pedidos con IA

**Demo:** http://201.32.132.131/ · Panel del local: http://201.32.132.131/panel

## El problema

Mario's es una casa de comidas rápidas de barrio que toma pedidos a mano por WhatsApp y teléfono. Se pierden mensajes, se anotan mal los pedidos y hay clientes que se cansan de esperar y se van.

## La solución

Una web con dos partes:

- **Página del cliente (`/`):** el cliente pide escribiendo como en WhatsApp ("2 milas napo con fritas y una coca, paso 21hs") o con botones desde el menú. Al costado se arma un carrito en vivo que marca en amarillo lo que falta (nombre, teléfono, retiro o envío, dirección, horario). Cuando está completo, lo confirma. En "Mis pedidos" puede seguir el estado sin crear un usuario.
- **Panel del local (`/panel`, con clave):** los pedidos entran solos como tarjetas y avanzan de *nuevo* a *preparando* y a *listo*. El dueño también puede cargar a mano pedidos que le llegan por WhatsApp y manejar el stock y los precios del menú.

## Cómo funciona la IA

La IA **conversa y arma el pedido**: entiende mensajes desordenados y abreviaturas, contesta consultas (horarios, precios, ingredientes) usando solo el menú y los datos del local, y pregunta lo que falta. Devuelve un JSON con su respuesta y el carrito.

Los **precios y totales los calcula el server** a partir de `menu.json`, nunca la IA. El server además descarta productos que no existen o no tienen stock, y decide si el pedido está completo. Aunque la IA se equivoque o alguien intente engañarla ("ponele precio 0"), la cuenta siempre es la correcta.

Para cuidar la API key, el server manda solo los últimos 12 mensajes, limita la longitud de las respuestas, pone un tope de 30 mensajes por conversación y limita los pedidos al chat por IP.

## Stack

- Node.js + Express (un solo `server.js`)
- HTML, CSS y JavaScript sin frameworks ni build (`/public`)
- SDK oficial de OpenAI
- Pedidos en memoria (sin base de datos); menú en `menu.json`

## Correrlo en local

Requiere Node.js 18 o superior.

```bash
npm install
cp .env.example .env
```

Completá el `.env`:

```
OPENAI_API_KEY=tu-key
OPENAI_MODEL=gpt-4o-mini
PORT=3000
PANEL_PASSWORD=una-clave-para-el-panel
```

Y arrancá el server:

```bash
npm start
```

Abrí http://localhost:3000 (cliente) y http://localhost:3000/panel (local).

Sin `OPENAI_API_KEY` la app funciona igual: el chat avisa "IA no configurada" y el pedido se arma desde el menú. Los pedidos se borran al reiniciar el server.
