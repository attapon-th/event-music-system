# คิวเพลิน

Independent jukebox sessions for events or venues: guests choose songs, an admin manages
the running order, and Players supply music to the venue.

## Language

### Rooms and admission

**Session**:
One temporary music room with its own running order, settings, guests, admins,
and Players. It ends after everyone has left for an hour.
_Avoid_: Login session, permanent venue.

**Room number**:
The three-digit number used to find and join a live Session. A later Session
may have the same number without inheriting its people or music.
_Avoid_: Password, permanent identity.

**Player entry code**:
A room number followed by the sum of its three digits, without padding the sum
with zeros. It creates that Session if absent, or joins its Players if already live.
_Avoid_: Secret password, random room number.

### People and screens

**Guest**:
A listener who can discover songs, request them, and view the shared running
order without signing in. A guest has no playback or queue-management authority.
_Avoid_: Admin, host, account holder.

**Admin**:
The first person to join by room number or QR link, automatically given room authority.
This primary operator controls playback
and the queue, and can grant or revoke Controller authority; Admin authority is fixed.
_Avoid_: Guest, player.

**Controller**:
A participant given playback and queue-management authority by an Admin or Controller.
A Controller can grant that authority to Guests, but cannot revoke it or change Admin/Player authority.
_Avoid_: Primary Admin, Player.

**Participant**:
A person who joined a Session, identified by their browser credential and
nickname. They remain listed while offline until the Session ends.
_Avoid_: Nickname as proof of identity.

**Player**:
A screen/device that plays the selected song, typically a TV, TV Box, or projector-connected computer.
Several Players may share a Session's song, pause state, and volume without synchronizing song position.
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
A selected YouTube video offered for playback, including music and other content. Separate uploads of
the same recording are distinct selections.
_Avoid_: Local audio file, album, playlist.

**Song request**:
A submission asking to play a song, subject to request limits, availability
checks; acceptance creates a queue item.
_Avoid_: Guaranteed playback, search result.

**Queue item**:
One song selection in the running order, originating from an accepted song request
or Auto Queue, with its song metadata and optional requester credit.
It keeps its identity when reordered or promoted to Now Playing.
_Avoid_: YouTube video identity, search result.

**Queue**:
The ordered collection of accepted requested items waiting to play after the current
song. The current song is outside the Queue.
_Avoid_: Now Playing, playback history, separate admin playlist.

**Auto Queue**:
A room setting, enabled by default, that plays ordered batches of YouTube video recommendations
when no requested songs remain. New requests replace the waiting automatic batch;
the current song finishes before the requested songs play.
_Avoid_: YouTube account personalization, adding recommendations to the request Queue.

**Automatic batch**:
Up to five automatic songs selected together in YouTube recommendation order,
played before selecting another batch from the latest song.
_Avoid_: Shuffled playlist, requested Queue, recommendations refreshed for every song.

**Automatic song**:
A song selected by Auto Queue rather than requested by a participant.
_Avoid_: Guest request, requester credit, an upcoming requested song.

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
item, or allows Auto Queue to select an automatic song when enabled. Otherwise,
the player stays idle when no upcoming item remains.
_Avoid_: Pause, remove an upcoming item.

**Clear Queue**:
An operator action that removes all upcoming items while retaining the current
song and its playback state.
_Avoid_: Stop playback, erase history.

**Explore**:
Song discovery through the configured country's chart, with shuffle
and five-song batches and no category buttons. Every search mode shows the same chart; search
mode controls specific searches. Its country preference does not limit song language.
_Avoid_: Thai-only catalog, personal recommendations.

**Request cooldown**:
A waiting period between song-request attempts that require availability
checks from a guest device, five seconds by default. It is not the delay until a song will play.
_Avoid_: Queue waiting time, playback delay.

**Content filter**:
An inactive legacy review of song suitability for the event; normal mode considers
the occasion, while strict mode requires family-friendly content.
_Avoid_: Availability check, Thai-language filter.

**Event description**:
The operator's description of the occasion or venue used to judge song suitability.
_Avoid_: Song description, deployment configuration.
