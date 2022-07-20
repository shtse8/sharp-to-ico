// https://github.com/steambap/png-to-ico
import type { OutputInfo, Sharp } from 'sharp'

const sizeList = [48, 32, 16]
const err = new Error('Please give me a square PNG image.')

export async function toIco(image: Sharp) {
  const { info } = await image.toBuffer({ resolveWithObject: true })
  const size = info.width
  if (info.format !== 'png' || size !== info.height)
    throw err

  if (size !== 256) {
    image = image.resize(256, 256, {
      kernel: 'cubic',
    // Jimp.RESIZE_BICUBIC
    })
  }

  const resizedImages = sizeList.map(targetSize =>
    image.clone().resize(targetSize, targetSize, {
      kernel: 'cubic',
      // Jimp.RESIZE_BICUBIC
    }),
  )

  return await imagesToIco(resizedImages.concat(image))
}

async function imagesToIco(images: Sharp[]) {
  const header = getHeader(images.length)
  const headerAndIconDir = [header]
  const imageDataArr = []

  let len = header.length
  let offset = header.length + 16 * images.length

  for (const img of images) {
    const { data, info } = await img
      .raw()
      .toBuffer({ resolveWithObject: true })

    const dir = getDir(info, offset)
    const bmpInfoHeader = getBmpInfoHeader(info)
    const dib = getDib(data, info)

    headerAndIconDir.push(dir)
    imageDataArr.push(bmpInfoHeader, dib)

    len += dir.length + bmpInfoHeader.length + dib.length
    offset += bmpInfoHeader.length + dib.length
  }

  return Buffer.concat(headerAndIconDir.concat(imageDataArr), len)
}

// https://en.wikipedia.org/wiki/ICO_(file_format)
function getHeader(numOfImages: number) {
  const buf = Buffer.alloc(6)

  buf.writeUInt16LE(0, 0) // Reserved. Must always be 0.
  buf.writeUInt16LE(1, 2) // Specifies image type: 1 for icon (.ICO) image
  buf.writeUInt16LE(numOfImages, 4) // Specifies number of images in the file.

  return buf
}

function getDir(info: OutputInfo, offset: number) {
  const buf = Buffer.alloc(16)
  const size = info.size! + 40
  const width = info.width! >= 256 ? 0 : info.width!
  const height = width
  const bpp = 32

  buf.writeUInt8(width, 0) // Specifies image width in pixels.
  buf.writeUInt8(height, 1) // Specifies image height in pixels.
  buf.writeUInt8(0, 2) // Should be 0 if the image does not use a color palette.
  buf.writeUInt8(0, 3) // Reserved. Should be 0.
  buf.writeUInt16LE(1, 4) // Specifies color planes. Should be 0 or 1.
  buf.writeUInt16LE(bpp, 6) // Specifies bits per pixel.
  buf.writeUInt32LE(size, 8) // Specifies the size of the image's data in bytes
  buf.writeUInt32LE(offset, 12) // Specifies the offset of BMP or PNG data from the beginning of the ICO/CUR file

  return buf
}

// https://en.wikipedia.org/wiki/BMP_file_format
function getBmpInfoHeader(info: OutputInfo) {
  const buf = Buffer.alloc(40)
  const width = info.width!
  // https://en.wikipedia.org/wiki/ICO_(file_format)
  // ...Even if the AND mask is not supplied,
  // if the image is in Windows BMP format,
  // the BMP header must still specify a doubled height.
  const height = width * 2
  const bpp = 32

  buf.writeUInt32LE(40, 0) // The size of this header (40 bytes)
  buf.writeInt32LE(width, 4) // The bitmap width in pixels (signed integer)
  buf.writeInt32LE(height, 8) // The bitmap height in pixels (signed integer)
  buf.writeUInt16LE(1, 12) // The number of color planes (must be 1)
  buf.writeUInt16LE(bpp, 14) // The number of bits per pixel
  buf.writeUInt32LE(0, 16) // The compression method being used.
  buf.writeUInt32LE(0, 20) // The image size.
  buf.writeInt32LE(0, 24) // The horizontal resolution of the image. (signed integer)
  buf.writeInt32LE(0, 28) // The vertical resolution of the image. (signed integer)
  buf.writeUInt32LE(0, 32) // The number of colors in the color palette, or 0 to default to 2n
  buf.writeUInt32LE(0, 36) // The number of important colors used, or 0 when every color is important; generally ignored.

  return buf
}

function getColorPixel(buffer: Buffer, x: number, y: number, width: number) {
  const pxPos = (y * width + x) * 4
  return {
    r: buffer[pxPos + 0],
    g: buffer[pxPos + 1],
    b: buffer[pxPos + 2],
    a: buffer[pxPos + 3],
  }
}

// https://en.wikipedia.org/wiki/BMP_file_format
// Note that the bitmap data starts with the lower left hand corner of the image.
// blue green red alpha in order
function getDib(data: Buffer, info: OutputInfo) {
  const size = info.size
  const width = info.width!
  const height = width
  const andMapRow = getRowStride(width)
  const andMapSize = andMapRow * height
  const buf = Buffer.alloc(size + andMapSize)
  // xor map
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b, a } = getColorPixel(data, x, y, width)
      const newColor = b | (g << 8) | (r << 16) | (a << 24)

      const pos = ((height - y - 1) * width + x) * 4
      // console.log('pos', pos)
      buf.writeInt32LE(newColor, pos)
    }
  }

  // and map. It's padded out to 32 bits per line
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { a } = getColorPixel(data, x, y, width)
      // TODO make threshhold configurable
      const alpha = a > 0 ? 0 : 1
      const bitNum = (height - y - 1) * width + x
      // width per line in multiples of 32 bits
      const width32
        = width % 32 === 0 ? Math.floor(width / 32) : Math.floor(width / 32) + 1

      const line = Math.floor(bitNum / width)
      const offset = Math.floor(bitNum % width)
      const bitVal = alpha & 0x00000001

      const pos = size + line * width32 * 4 + Math.floor(offset / 8)
      const newVal = buf.readUInt8(pos) | (bitVal << (7 - (offset % 8)))
      buf.writeUInt8(newVal, pos)
    }
  }

  return buf
}

function getRowStride(width: number) {
  if (width % 32 === 0)
    return width / 8
  else
    return 4 * (Math.floor(width / 32) + 1)
}
