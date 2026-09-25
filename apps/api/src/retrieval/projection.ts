export interface Projection {
  coordinates: number[][];
  /** Fraction of total variance captured by each retained component. */
  explainedVariance: number[];
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

function normalise(vector: number[]): number[] {
  const magnitude = Math.sqrt(dot(vector, vector));
  if (magnitude < 1e-12) return vector.map(() => 0);
  return vector.map((value) => value / magnitude);
}

/** Removes the parts of `vector` already explained by earlier components, so
 *  each successive axis is orthogonal to the ones before it. */
function orthogonalise(vector: number[], basis: number[][]): number[] {
  let result = vector;
  for (const component of basis) {
    const projection = dot(result, component);
    result = result.map((value, index) => value - projection * component[index]!);
  }
  return result;
}

/**
 * Three-component PCA by power iteration with deflation.
 *
 * Power iteration is used rather than a full eigendecomposition because the
 * vectors are 384-dimensional and only the first three components are wanted;
 * a covariance matrix would be 384x384 and is never formed. The seed is
 * deterministic so the same corpus always projects to the same picture, which
 * matters when the map is a figure in a report.
 */
export function pca3(vectors: number[][]): Projection {
  const count = vectors.length;
  if (count === 0) return { coordinates: [], explainedVariance: [0, 0, 0] };

  const dimensions = vectors[0]!.length;
  if (count === 1) return { coordinates: [[0, 0, 0]], explainedVariance: [0, 0, 0] };

  const means = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    for (let d = 0; d < dimensions; d += 1) means[d]! += vector[d]! / count;
  }
  const centred = vectors.map((vector) => vector.map((value, d) => value - means[d]!));

  const totalVariance = centred.reduce((sum, row) => sum + dot(row, row), 0);
  const components: number[][] = [];
  const variances: number[] = [];

  for (let c = 0; c < 3; c += 1) {
    let candidate = normalise(
      orthogonalise(
        Array.from({ length: dimensions }, (_, i) => Math.sin((i + 1) * (c + 1) * 0.017) + 0.1),
        components,
      ),
    );

    for (let iteration = 0; iteration < 64; iteration += 1) {
      const next = new Array<number>(dimensions).fill(0);
      for (const row of centred) {
        const scale = dot(row, candidate);
        for (let d = 0; d < dimensions; d += 1) next[d]! += scale * row[d]!;
      }
      const orthogonal = normalise(orthogonalise(next, components));
      if (orthogonal.every((value) => value === 0)) break;

      // Converged once the axis stops moving; 1 - |cos| is the angle between
      // successive estimates.
      const movement = 1 - Math.abs(dot(orthogonal, candidate));
      candidate = orthogonal;
      if (movement < 1e-9) break;
    }

    components.push(candidate);
    variances.push(centred.reduce((sum, row) => sum + dot(row, candidate) ** 2, 0));
  }

  const coordinates = centred.map((row) => components.map((component) => dot(row, component)));

  return {
    coordinates,
    explainedVariance: variances.map((value) =>
      totalVariance > 0 ? Number((value / totalVariance).toFixed(4)) : 0,
    ),
  };
}
