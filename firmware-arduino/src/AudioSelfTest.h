#ifndef AUDIOSELFTEST_H
#define AUDIOSELFTEST_H

// Built only into the `-audiotest` environment. Drives the speaker from
// locally generated samples with the radio down and neither the websocket nor
// the Opus decoder in the picture, so that a noise heard here can only come
// from I2S, the amplifier, the speaker or the supply. Never returns.
void runAudioSelfTest();

#endif
