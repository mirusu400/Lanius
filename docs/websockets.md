# WebSockets

The **WebSockets** view under Proxy records text and binary messages in both
directions. Turn interception on for client messages, server messages, or both,
then edit and forward or drop held messages. A captured message can also be
edited and sent again to either side of its still-active connection. Binary
messages are shown and edited as Base64 so their bytes are not corrupted.

WebSocket message history is stored as raw bytes in the project database. The
view loads 200 at a time and can page through all earlier messages after a
restart. `GET /api/websockets/messages/{id}/raw` returns the exact frame bytes.

The divider between the message list and the detail pane can be dragged to
resize either side, and the position is remembered on this machine.
