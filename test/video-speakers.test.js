import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clusterEmbeddings, labelSpeakers } from '../src/main/video/speakers.js'

// 会议视频分说话人：每句的声纹向量按时间顺序聚类。向量用「几个说话人的中心加一点噪声」来做，不加载真模型。

let seed = 11
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const unit = (v) => {
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0))
  return Float32Array.from(v, (x) => x / n)
}
const centerOf = (k, dim = 32) => unit(Array.from({ length: dim }, (_, i) => (i % 8 === k ? 1 : 0.05 * (rnd() - 0.5))))
const around = (c, noise = 0.25) => unit(Array.from(c, (x) => x + noise * (rnd() - 0.5)))

test('三个人轮流说话：分成三类，编号按第一次出现的先后', () => {
  const cs = [centerOf(0), centerOf(1), centerOf(2)]
  const truth = [1, 0, 1, 2, 0, 1, 2, 2, 0, 1, 0, 2, 1, 0, 2]
  const labels = clusterEmbeddings(truth.map((k) => ({ embedding: around(cs[k]) })))
  assert.equal(new Set(labels).size, 3)
  // 同一个人同一个号
  const map = new Map()
  truth.forEach((k, i) => (map.has(k) ? assert.equal(map.get(k), labels[i]) : map.set(k, labels[i])))
  assert.equal(labels[0], 0, '第一个说话的是说话人 1')
})

test('一个人说到底：只有一类；太短算不出向量的句子跟前一句', () => {
  const c = centerOf(3)
  const items = Array.from({ length: 10 }, () => ({ embedding: around(c) }))
  items[4] = { embedding: null }
  items[0] = { embedding: null }
  assert.deepEqual(clusterEmbeddings(items), Array(10).fill(0))
  assert.deepEqual(clusterEmbeddings([{ embedding: null }, { embedding: null }]), [0, 0])
  assert.deepEqual(clusterEmbeddings([]), [])
})

test('只出现一两句的类并进最像的那一类；超过上限的说话人并掉小的', () => {
  const cs = [centerOf(0), centerOf(1)]
  const items = [...Array.from({ length: 6 }, () => cs[0]), ...Array.from({ length: 6 }, () => cs[1]), centerOf(5)].map((c) => ({ embedding: around(c, 0.1) }))
  const labels = clusterEmbeddings(items)
  assert.equal(new Set(labels).size, 2, '孤零零的一句不单独算一个人')
  const many = Array.from({ length: 5 }, (_, k) => Array.from({ length: 4 }, () => ({ embedding: around(centerOf(k), 0.1) }))).flat()
  assert.equal(new Set(clusterEmbeddings(many, { maxSpeakers: 3 })).size, 3)
})

test('labelSpeakers：短句（不到 1.2 秒）不算向量，向量不够 0.8 秒有效语音的也不要', async () => {
  const asked = []
  const scorer = {
    scorePcm: async (pcm) => {
      asked.push(pcm.length)
      return { embedding: unit([1, 0, 0, 0]), seconds: pcm.length >= 16000 ? 2 : 0.3 }
    },
  }
  const sentences = [{ startMs: 0, endMs: 3000 }, { startMs: 3000, endMs: 3500 }, { startMs: 4000, endMs: 20_000 }]
  const r = await labelSpeakers(sentences, { readPcm: async (a, b) => new Int16Array(((b - a) / 1000) * 16000), scorer })
  assert.deepEqual(r, { labels: [0, 0, 0], count: 1 })
  assert.equal(asked.length, 2)
  assert.equal(asked[1], 8 * 16000, '一句最多取 8 秒')
})
