# Decoder and Diff

## Decoder

Chain encoders and decoders: URL, Base64, hex, HTML, gzip, JWT and common
hashes. Every step shows its own output, so you can see where a chain goes
wrong, and the result pane shows the final value as text or as a hex dump.

The Decoder keeps several payloads open at once, each with its own chain, so
you can work through a handful of tokens without losing the one before.

## Diff

Compare two requests or responses word by word or byte by byte. The divider
between the two panes can be dragged to resize them, and the position is
remembered on this machine.
