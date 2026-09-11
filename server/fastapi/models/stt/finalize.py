"""In-band signal that a push-to-talk client has committed its turn."""

from dataclasses import dataclass

from pipecat.frames.frames import SystemFrame


@dataclass
class STTFinalizeFrame(SystemFrame):
    """Ask a streaming recognizer to emit the current phrase now.

    Push-to-talk clients stop sending audio the instant the button comes up.
    Azure (and similar streaming recognizers) decide a phrase is over from
    silence *in the stream*, so without this they sit on the last words until
    a silence timeout or an idle disconnect. Same priority as input audio and
    ``UserStoppedSpeakingFrame`` so it cannot jump ahead of samples still in
    the system queue.
    """

    pass
