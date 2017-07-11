import crypto from 'crypto'

import AbstractChain from './AbstractChain'
import CipherKey from './CipherKey'

import {
  ALGO_CIPHER,
  RATCHET_KEY_LENGTH,
  HEADER_LENGTH,
  AUTHENTICATION_TAG_LENGTH,
  MESSAGE_KEY_TTL,
} from './consts'

import {
  concatBuffers,
  compare,
} from './utils'

export default class ReceivingChain extends AbstractChain {

  constructor(ratchet, nextHeaderKey) {
    super(ratchet, null, nextHeaderKey)
    this.skipped = []
  }

  decryptHeader(cipherText) {
    for (let headerKey of this.getHeaderKeys()) {
      const output = this._decrypt(cipherText, headerKey)
      if (output !== false) {
        return {
          count:         output.readInt16LE(0),
          previous:      output.readInt16LE(2),
          usedNext:      compare(this.nextHeaderKey.content, headerKey.content),
        }
      }
    }
    return false
  }

  decrypt(payload) {
    const {
      headerCipherText,
      ratchetKey,
      cipherText,
      authenticationTag,
    } = this.deserialize(payload)

    const plainText = this.trySkipped(cipherText, headerCipherText, authenticationTag)

    if (plainText !== false) {
      return plainText
    }

    const header = this.decryptHeader(headerCipherText)

    if (header === false) {
      return false
    }

    const {
      count,
      previous,
      usedNext,
    } = header

    let skipAfter = 0

    if (usedNext) {
      this.deleteOldKeys()
      this.skip(previous - this.count)
      this.ratchet.ratchet(ratchetKey)
      skipAfter = count
    } else {
      skipAfter = count - this.count
    }

    this.skip(skipAfter)

    if (!this.validAuthenticationTag(authenticationTag, headerCipherText, cipherText, this.messageKey.auth)) {
      return false
    }

    const output = this._decrypt(cipherText, this.messageKey)

    if (output !== false) {
      this.step()
      return output
    }

    return false
  }

  deserialize(data) {
    let offset = 0

    const headerCipherText = data.slice(offset, offset + HEADER_LENGTH)
    offset += HEADER_LENGTH

    const ratchetKey = data.slice(offset, offset + RATCHET_KEY_LENGTH)
    offset += RATCHET_KEY_LENGTH

    const authenticationTag = data.slice(offset, offset + AUTHENTICATION_TAG_LENGTH)
    offset += AUTHENTICATION_TAG_LENGTH

    const cipherText = data.slice(offset)

    return {
      headerCipherText,
      ratchetKey,
      cipherText,
      authenticationTag,
    }
  }

  skip(count) {
    if (count <= 0) {
      return 0
    }
    const until = count + this.count
    for (var i = this.count; i < until; i++) {
      this.skipped.push({
        header:   new CipherKey(this.headerKey),
        message:  new CipherKey(this.messageKey),
        missed:   0,
      })
      this.step()
    }
  }

  deleteOldKeys() {
    for (var i = 0; i < this.skipped.length; i++) {
      if (++this.skipped[i].missed > MESSAGE_KEY_TTL) {
        this.skipped.splice(i, 1)
      }
    }
  }

  trySkipped(cipherText, headerCipherText, authenticationTag) {
    for (var i = 0; i < this.skipped.length; i++) {
      if (!this.validAuthenticationTag(authenticationTag, headerCipherText, cipherText, this.skipped[i].message.auth)) {
        continue
      }
      const output = this._decrypt(cipherText, this.skipped[i].message)
      if (output === false) {
        continue
      }
      this.skipped.splice(i, 1)
      return output
    }
    return false
  }

  validAuthenticationTag(authenticationTag, headerCipherText, cipherText, authenticationKey) {
    return compare(authenticationTag, this.makeAuthenticationTag(headerCipherText, cipherText, authenticationKey))
  }

  _decrypt(data, key) {
    try {
      const decipher = crypto.createDecipheriv(ALGO_CIPHER, key.content, key.iv)
      return concatBuffers([
        decipher.update(data),
        decipher.final(),
      ])
    } catch (e) {
      return false
    }
  }

  getHeaderKeys() {
    return this.skipped.map(skippedKey => skippedKey.header).concat([ this.headerKey, this.nextHeaderKey ])
  }

  getState() {
    return {
      skipped: this.skipped,
      ...this.getCoreState()
    }
  }

}