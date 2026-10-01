# Event Music System

A shared jukebox for an event or venue: guests choose songs, an admin manages
the running order, and a designated player supplies music to the venue.

## Language

### People and screens

**Guest**:
A listener who can discover songs, request them, and view the shared running
order without signing in. A guest has no playback or queue-management authority.
_Avoid_: Admin, host, account holder.

**Admin**:
An authorized operator who controls playback and edits the shared queue,
including selecting a queued song to play immediately.
_Avoid_: Guest, player.

**Player**:
The designated screen/device that plays the selected song through the venue's
audio system, typically a TV, TV Box, or projector-connected computer.
_Avoid_: Admin dashboard, guest phone.

**Host**:
The legacy name for the Player screen, which also exposes operator controls.
Use Player for the playback role and Admin for the remote operator role.
_Avoid_: Using host to mean both a screen and a person without qualification.

**Requester**:
The guest or admin who submitted a song request. A displayed requester name is
optional attribution, not proof of identity or control privileges.
_Avoid_: Owner, authenticated user.

### Songs and running order

**Song**:
A selected YouTube video offered as music for playback. Separate uploads of
the same recording are distinct selections.
_Avoid_: Local audio file, album, playlist.

**Song request**:
A submission asking to play a song, subject to request limits, availability
checks, and the content filter when enabled; acceptance creates a queue item.
_Avoid_: Guaranteed playback, search result.

**Queue item**:
One accepted song request with its song metadata and optional requester credit.
It keeps its identity when reordered or promoted to Now Playing.
_Avoid_: YouTube video identity, search result.

**Queue**:
The ordered collection of accepted items waiting to play after the current
song. The current song is outside the Queue.
_Avoid_: Now Playing, playback history, separate admin playlist.

**Now Playing**:
The selected current queue item, which may be playing or paused. This label
identifies the current song rather than confirming audible output.
_Avoid_: First upcoming item, proof of successful playback.

**Playback history**:
Items that have left Now Playing, including songs replaced or skipped before
completion. History does not imply that each song was heard in full.
_Avoid_: Upcoming queue, completed-song list.

### Controls and discovery

**Play Now**:
An operator action that replaces the current song with a selected upcoming
item, leaving the other upcoming items in their existing relative order.
_Avoid_: Add to queue, move to next position, resume.

**Skip**:
An operator action that leaves the current song and selects the next upcoming
item, or leaves the player idle when none remains.
_Avoid_: Pause, remove an upcoming item.

**Clear Queue**:
An operator action that removes all upcoming items while retaining the current
song and its playback state.
_Avoid_: Stop playback, erase history.

**Explore**:
Song discovery through country charts, genres, and artist suggestions before
or alongside a specific search. Its country preference does not limit song language.
_Avoid_: Thai-only catalog, personal recommendations.

**Request cooldown**:
A waiting period between song-request attempts that require availability or
content checks from a guest device. It is not the delay until a song will play.
_Avoid_: Queue waiting time, playback delay.

**Content filter**:
An optional review of song suitability for the event; normal mode considers
the occasion, while strict mode requires family-friendly content.
_Avoid_: Availability check, Thai-language filter.

**Event description**:
The operator's description of the occasion or venue used to judge song suitability.
_Avoid_: Song description, deployment configuration.
