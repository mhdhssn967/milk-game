const fs = require('fs');
let c = fs.readFileSync('D:/Personal/multiplayer/server/src/index.ts', 'utf8');

if (!c.includes('names: Record<string, string>')) {
    c = c.replace(
        'turnIndex: number;',
        'turnIndex: number;\n  names: Record<string, string>;'
    );

    c = c.replace(
        "socket.on('milkCreateRoom', () => {",
        "socket.on('milkCreateRoom', (playerName: string) => {"
    );

    c = c.replace(
        'turnIndex: 0',
        "turnIndex: 0,\n      names: { [socket.id]: playerName || 'Host' }"
    );
    
    c = c.replace(
        "socket.emit('milkPlayersUpdate', milkRooms[roomId].players);",
        "socket.emit('milkPlayersUpdate', { players: milkRooms[roomId].players, names: milkRooms[roomId].names });"
    );
    
    c = c.replace(
        "socket.on('milkJoinRoom', (roomId: string) => {",
        "socket.on('milkJoinRoom', (data: { roomId: string, name: string }) => {\n    const roomId = data.roomId;"
    );
    
    c = c.replace(
        'room.players.push(socket.id);',
        "room.players.push(socket.id);\n      room.names[socket.id] = data.name || 'Player';"
    );
    
    c = c.replace(
        "io.to(roomId).emit('milkPlayersUpdate', room.players);",
        "io.to(roomId).emit('milkPlayersUpdate', { players: room.players, names: room.names });"
    );
}

fs.writeFileSync('D:/Personal/multiplayer/server/src/index.ts', c);
